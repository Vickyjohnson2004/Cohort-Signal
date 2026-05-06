/**
 * Minimal BigQuery REST client.
 *
 * We don't pull in the full @google-cloud/bigquery SDK because (a) it's
 * heavy and brings transitive grpc dependencies, and (b) we only need
 * three operations: run a query, page through results, and dry-run for
 * cost estimation. The REST API is the documented stable surface and is
 * what the SDK calls under the hood anyway.
 *
 * Auth: service-account JSON key (signed JWT -> OAuth access token).
 *       Uses google-auth-library (small, official).
 *
 * Cost-safety: every query passes `maximumBytesBilled` so a runaway query
 * cannot exceed our configured cap. The default cap is 50 GB per query.
 */

import { GoogleAuth } from "google-auth-library";
import type { JWTInput } from "google-auth-library";

const BIGQUERY_BASE = "https://bigquery.googleapis.com/bigquery/v2";
const SCOPES = ["https://www.googleapis.com/auth/bigquery.readonly"];

export interface BigQueryClientOptions {
  /**
   * Raw service-account JSON (alternative to keyFilename). Preferred on
   * Railway where secrets live in env vars instead of disk.
   */
  credentials?: JWTInput;
  /**
   * Path to service-account JSON, or null to use Application Default
   * Credentials (env var GOOGLE_APPLICATION_CREDENTIALS).
   */
  keyFilename?: string;
  /** GCP project ID under which to run queries (billed). */
  projectId?: string;
  /** Default location for query jobs. Public datasets are in 'US'. */
  location?: string;
  /** Cap on bytes billed per query. Default 50 GB. */
  defaultMaximumBytesBilled?: number;
  /** Default request timeout (ms). */
  timeoutMs?: number;
}

export interface QueryRequest {
  query: string;
  /** Cap bytes billed for this query (overrides client default). */
  maximumBytesBilled?: number;
  /** Treat the query as a dry-run (no execution, returns byte estimate). */
  dryRun?: boolean;
  /** Maximum rows per page. Default 10000. */
  maxResults?: number;
  /** Query parameters (named or positional). */
  parameters?: Array<{
    name?: string;
    parameterType: { type: string };
    parameterValue: { value: string };
  }>;
}

export interface QueryRow {
  /** BigQuery returns each row as { f: [{v: <stringified value>}] }. */
  f: Array<{ v: string | null | object }>;
}

export interface QueryResponse {
  /** Names of columns, in order. */
  schema: Array<{ name: string; type: string; mode?: string }>;
  /** Bytes processed; 0 if cache hit. */
  totalBytesProcessed: number;
  /** Whether the response was served from cache. */
  cacheHit: boolean;
  /** Job reference (for paging). */
  jobReference: { jobId: string; location?: string; projectId: string };
  /** First page of rows. */
  rows: QueryRow[];
  /** Pagination token; iterate via getQueryResults if present. */
  pageToken?: string;
  /** Whether the job is done. */
  jobComplete: boolean;
}

export class BigQueryError extends Error {
  override readonly name = "BigQueryError";
  constructor(
    message: string,
    public readonly status: number,
    public readonly bqReason?: string,
    public readonly bqLocation?: string,
  ) {
    super(message);
  }
}

export class BigQueryClient {
  private readonly auth: GoogleAuth;
  private readonly projectId: string;
  private readonly location: string;
  private readonly defaultMaxBytes: number;
  private readonly timeoutMs: number;

  constructor(opts: BigQueryClientOptions = {}) {
    let pid = opts.projectId ?? process.env.GCP_PROJECT_ID ?? "";
    const creds = opts.credentials as { project_id?: string } | undefined;
    if (!pid && creds?.project_id) pid = String(creds.project_id);
    if (!pid) {
      throw new Error(
        "BigQueryClient: projectId must be provided via opts.projectId, GCP_PROJECT_ID env var, or credentials.project_id.",
      );
    }
    this.projectId = pid;
    this.auth = new GoogleAuth({
      credentials: opts.credentials,
      keyFilename: opts.keyFilename,
      scopes: SCOPES,
    });
    this.location = opts.location ?? "US";
    this.defaultMaxBytes =
      opts.defaultMaximumBytesBilled ?? 50 * 1024 * 1024 * 1024; // 50 GB
    this.timeoutMs = opts.timeoutMs ?? 600_000; // 10 min
  }

  /**
   * Run a query, returning the first page. For multi-page results, use
   * `runQueryStream` instead.
   */
  async runQuery(req: QueryRequest): Promise<QueryResponse> {
    const tok = await this.token();
    const body = {
      query: req.query,
      useLegacySql: false,
      location: this.location,
      maximumBytesBilled: String(req.maximumBytesBilled ?? this.defaultMaxBytes),
      maxResults: req.maxResults ?? 10_000,
      dryRun: Boolean(req.dryRun),
      timeoutMs: 60_000, // BigQuery server-side timeout for the synchronous query.
      ...(req.parameters
        ? {
            queryParameters: req.parameters,
            parameterMode: "named",
          }
        : {}),
    };
    const url = `${BIGQUERY_BASE}/projects/${this.projectId}/queries`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tok}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      let json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const err = (json.error as Record<string, unknown> | undefined) ?? {};
        const errors = (err.errors as Array<{ reason?: string; location?: string; message?: string }>) ?? [];
        throw new BigQueryError(
          `BigQuery HTTP ${res.status}: ${(err.message as string | undefined) ?? JSON.stringify(json).slice(0, 300)}`,
          res.status,
          errors[0]?.reason,
          errors[0]?.location,
        );
      }
      let parsed = parseQueryResponse(json);
      // Large scans exceed the synchronous wait window — poll job until DONE,
      // then fetch the first results page explicitly.
      if (!parsed.jobComplete && parsed.jobReference.jobId) {
        await this.pollJobUntilDone(parsed.jobReference);
        parsed = await this.fetchQueryResultsPage(parsed.jobReference, undefined, req.maxResults ?? 10_000);
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Poll jobs.get until the query job finishes (or fails).
   */
  private async pollJobUntilDone(job: { jobId: string; location?: string; projectId: string }): Promise<void> {
    const loc = job.location ?? this.location;
    const url = `${BIGQUERY_BASE}/projects/${encodeURIComponent(job.projectId)}/jobs/${encodeURIComponent(job.jobId)}?location=${encodeURIComponent(loc)}`;
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const tok = await this.token();
      const res = await fetch(url, { headers: { authorization: `Bearer ${tok}` } });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        throw new BigQueryError(`jobs.get HTTP ${res.status}: ${JSON.stringify(json).slice(0, 400)}`, res.status);
      }
      const status = json.status as { state?: string; errorResult?: { message?: string } } | undefined;
      const state = status?.state;
      if (state === "DONE") {
        if (status?.errorResult) {
          throw new BigQueryError(
            `BigQuery job failed: ${status.errorResult.message ?? JSON.stringify(status.errorResult)}`,
            500,
          );
        }
        return;
      }
      if (state === "FAILED") {
        throw new BigQueryError(`BigQuery job FAILED: ${JSON.stringify(status)}`, 500);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new BigQueryError("BigQueryClient: pollJobUntilDone exceeded client timeoutMs", 504);
  }

  /**
   * GET query results for a completed job (first page when pageToken omitted).
   */
  private async fetchQueryResultsPage(
    job: { jobId: string; location?: string; projectId: string },
    pageToken: string | undefined,
    maxResults: number,
  ): Promise<QueryResponse> {
    const tok = await this.token();
    const params = new URLSearchParams({
      maxResults: String(maxResults),
      ...(job.location ? { location: job.location } : { location: this.location }),
    });
    if (pageToken) params.set("pageToken", pageToken);
    const url = `${BIGQUERY_BASE}/projects/${encodeURIComponent(job.projectId)}/queries/${encodeURIComponent(job.jobId)}?${params.toString()}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${tok}` },
        signal: ctrl.signal,
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        throw new BigQueryError(
          `fetchQueryResultsPage HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`,
          res.status,
        );
      }
      return parseQueryResponse(json);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run a query and stream every row through a callback. The callback may
   * be async; we await it before fetching the next row so backpressure
   * works (e.g. you can write rows to Postgres without buffering all of
   * them in memory).
   *
   * Pagination is automatic via the getQueryResults endpoint.
   */
  async runQueryStream(
    req: QueryRequest,
    onRow: (row: Record<string, unknown>) => void | Promise<void>,
    onProgress?: (info: { rowsSeen: number; pageBytes: number }) => void,
  ): Promise<{ totalRows: number; totalBytesProcessed: number; cacheHit: boolean }> {
    const initial = await this.runQuery(req);
    let total = 0;
    const consumePage = async (resp: QueryResponse) => {
      const colNames = resp.schema.map((s) => s.name);
      for (const r of resp.rows) {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < colNames.length; i++) {
          const col = colNames[i];
          if (col !== undefined) obj[col] = r.f[i]?.v ?? null;
        }
        await onRow(obj);
      }
      total += resp.rows.length;
    };
    await consumePage(initial);
    onProgress?.({ rowsSeen: total, pageBytes: initial.totalBytesProcessed });

    let pageToken = initial.pageToken;
    let job = initial.jobReference;
    while (pageToken) {
      const next = await this.fetchQueryResultsPage(job, pageToken, req.maxResults ?? 10_000);
      await consumePage(next);
      onProgress?.({ rowsSeen: total, pageBytes: 0 });
      pageToken = next.pageToken;
      job = next.jobReference;
    }
    return {
      totalRows: total,
      totalBytesProcessed: initial.totalBytesProcessed,
      cacheHit: initial.cacheHit,
    };
  }

  /**
   * Estimate bytes billed without running. Pass dryRun: true to runQuery.
   */
  async dryRun(query: string): Promise<{ totalBytesProcessed: number; valid: boolean; error?: string }> {
    try {
      const r = await this.runQuery({ query, dryRun: true });
      return { totalBytesProcessed: r.totalBytesProcessed, valid: true };
    } catch (err) {
      return {
        totalBytesProcessed: 0,
        valid: false,
        error: (err as Error).message,
      };
    }
  }

  private async token(): Promise<string> {
    const client = await this.auth.getClient();
    const t = await client.getAccessToken();
    if (!t.token) throw new Error("BigQueryClient: failed to acquire access token");
    return t.token;
  }
}

function parseQueryResponse(json: Record<string, unknown>): QueryResponse {
  const schema = ((json.schema as { fields?: Array<{ name: string; type: string; mode?: string }> } | undefined)?.fields) ?? [];
  return {
    schema,
    totalBytesProcessed: Number(json.totalBytesProcessed ?? 0),
    cacheHit: Boolean(json.cacheHit),
    jobReference: (json.jobReference as QueryResponse["jobReference"]) ?? {
      jobId: "",
      projectId: "",
    },
    rows: (json.rows as QueryRow[] | undefined) ?? [],
    pageToken: json.pageToken as string | undefined,
    jobComplete: Boolean(json.jobComplete ?? true),
  };
}
