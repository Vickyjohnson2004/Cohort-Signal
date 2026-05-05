# CohortSignal methodology

This document describes the deterministic algorithms used to compute every value CohortSignal returns. Every successful response also embeds the relevant rules verbatim in its `methodology` field — this document is the long-form, audit-friendly version of the same rules.

## Source of truth

The chain data used to compute cohort metrics comes from the [Google BigQuery `bigquery-public-data.crypto_bitcoin` public dataset](https://cloud.google.com/blog/topics/public-datasets/bitcoin-in-bigquery-blockchain-analytics-on-public-data). The dataset is updated every 24 hours from the same Bitcoin Core nodes used by Blockchain ETL and follows a canonical schema that mirrors the chain itself. Anyone with a Google Cloud account can paste our SQL and reproduce our snapshots to the satoshi.

The dataset gives us, for every Bitcoin transaction, the full list of inputs (with `spent_transaction_hash` + `spent_output_index` referring to the previously-created UTXO) and outputs (with `value` in satoshis). From these we derive the UTXO-age series.

## Long-term holder boundary

A UTXO is "long-term held" if its age at the snapshot date is **>= 155 days**. This matches Glassnode's published threshold and is the most widely cited boundary in academic and industry literature. The boundary is configurable per-call via `cohortBoundaryDays` (allowed range: 7..1825 days).

## UTXO-age binning

For each unspent UTXO with creation block `B` and value `V` satoshis at snapshot date `D`:

```
ageDays = floor(D - blockDate(B))         # whole UTC days
band = the unique band such that band.minDays <= ageDays < band.maxDays
```

The 10 canonical age bands match Glassnode's HODL waves dashboard:

| Band | Range (days) |
|---|---|
| `under_1m` | [0, 30) |
| `1m_3m` | [30, 90) |
| `3m_6m` | [90, 180) |
| `6m_12m` | [180, 365) |
| `1y_2y` | [365, 730) |
| `2y_3y` | [730, 1095) |
| `3y_5y` | [1095, 1825) |
| `5y_7y` | [1825, 2555) |
| `7y_10y` | [2555, 3650) |
| `over_10y` | [3650, ∞) |

The total BTC per band is reported as `hodlWaves.btc[band]`. The fraction-of-supply is reported as `hodlWaves.pctOfSupply[band]`. The dominant band is the one with the largest `pctOfSupply`.

## LTH/STH supply

```
lthSupplyBtc = sum of V for all unspent UTXOs with ageDays >= cohortBoundaryDays
sthSupplyBtc = sum of V for all unspent UTXOs with ageDays <  cohortBoundaryDays
circulatingSupplyBtc = lthSupplyBtc + sthSupplyBtc
lthSupplyPctOfCirculating = lthSupplyBtc / circulatingSupplyBtc
```

`circulatingSupplyBtc` is computed from accounted UTXOs rather than from Bitcoin's closed-form issuance schedule. This is intentional: the cohort sums are the ground truth we report, so the denominator is taken from the same accounting. For sanity-checking, we include `circulatingSupplyBtcAt(blockHeight)` as a closed-form helper in `packages/core/src/util/circulating.ts`.

## LTH net position change

The 24-hour change in LTH supply (signed BTC):

```
lthNetPositionChangeBtc1d(D) = lthSupplyBtc(D) - lthSupplyBtc(D - 1)
```

Trailing-window means:

```
lthNetPositionChangeBtcNdAvg = mean of lthNetPositionChangeBtc1d over [D - N + 1, D]
```

## LTH-SOPR

For every Bitcoin spend where the spent UTXO's age was `>= cohortBoundaryDays` days at the time of spend:

```
LTH-SOPR(D) = sum(spend_value_usd_at_spend) / sum(spend_value_usd_at_creation)
              over all qualifying spends on UTC date D
```

Returns `null` for dates with no qualifying spends. USD values come from BigQuery's `inputs` table, which carries `value_usd` and `spending_value_usd` joined to a daily price curve.

Status thresholds:
- `above_one`: SOPR > 1.005
- `below_one`: SOPR < 0.995
- `neutral`: in between

State labels:
- `capitulation`: SOPR < 0.97 (LTHs realizing > 3% losses on spends)
- `profit_taking`: SOPR > 1.03 AND 30d-avg also > 1.03
- `hodl_dominant`: 30d-avg of |daily LTH net position change| / lthSupplyBtc < 0.05% AND SOPR is in the neutral band
- `neutral_spending`: everything else

## Regime classifier

Three orthogonal signals at the snapshot date:

1. **Supply trajectory** (`growing` / `shrinking` / `flat`): based on 30d % delta of LTH supply (±0.20% threshold)
2. **Spending pressure** (`profit` / `loss` / `neutral`): based on current LTH-SOPR (±1.0% from 1.0)
3. **Young-supply rotation** (`rotating_to_young` / `rotating_to_old` / `flat`): based on 30d delta of `under_1m` HODL waves share (±1.0pp threshold)

Decision rules, applied top-down (first match wins):

```
A. growing  AND  spending != profit  AND  rotation != rotating_to_young  ->  accumulation
B. shrinking AND (spending == profit  OR  rotation == rotating_to_young) ->  distribution
C. shrinking AND  spending == loss   AND  rotation != rotating_to_young  ->  distribution
D. growing  AND  spending == profit                                       ->  equilibrium
E. else                                                                   ->  equilibrium
```

Trend label (over 7d/30d/90d LTH supply % deltas):

```
all 3 within ±0.05% of zero            -> flat
all 3 >= 0  and  daily-rate(7d) > daily-rate(30d) > daily-rate(90d)   -> accelerating_up
all 3 >= 0  and  not above                                            -> decelerating_up
all 3 <= 0  and  daily-rate(7d) < daily-rate(30d) < daily-rate(90d)   -> accelerating_down
all 3 <= 0  and  not above                                            -> decelerating_down
otherwise                                                              -> flat
```

## Deterministic regime narrative

`regimeNarrative` is built mechanically from the structured fields. There is no LLM call. Re-running the formatter on the same input always produces the same string. The five sentences are:

1. As of `<asOfDate>` (block `<blockHeight>`), Bitcoin LTHs hold `<lthSupplyBtc>` BTC (`<lthPct>` of circulating supply); STHs hold `<sthSupplyBtc>` BTC.
2. Over the trailing 30 days, LTH supply has `<increased/decreased/remained flat>` by `<delta30d>`; the cross-window trend is `<trend>`.
3. LTH-SOPR is `<sopr>` (30d avg `<sopr30dAvg>`), state: `<state>`.
4. Dominant HODL waves band: `<dominantBand>`. Largest 30d band shifts: `<top3 by abs delta>`.
5. Regime classifier: `<accumulation/equilibrium/distribution>`.

## Provisional flag

The most-recent snapshot row may be marked `provisional: true` when:
- The chain tip has fewer than 6 confirmations behind the day boundary, OR
- The BigQuery dataset hasn't yet published the day's data (typically a 6-12h delay).

Provisional rows are subject to revision. Once the daily reconciliation pass succeeds, the row's `provisional` flag flips to `false` and it never changes again.

## Reproducibility

For any historical date `D` and `cohortBoundaryDays` value `C`, the cohort_snapshots row produced by CohortSignal is a deterministic function of `(D, C)` plus the BigQuery `crypto_bitcoin` data current at the time of computation. Anyone re-running the indexer against the same dataset will produce byte-identical snapshot rows.

This is the "self-maintained UTXO-age indexer using the Glassnode-standard 155-day cohort definition" the proposal commits to.
