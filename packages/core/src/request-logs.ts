import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultDatabasePath } from "./accounts";
import type { GatewayRoute, ProviderId } from "./index";
import { Database } from "./sqlite";

export type RequestLogEventType =
  | "selected"
  | "response"
  | "retry"
  | "missing"
  | "credential_unavailable";

export interface RequestLogRecord {
  id: number;
  requestId: string;
  provider: ProviderId;
  route?: GatewayRoute;
  model?: string;
  sessionKey: string;
  accountId?: string;
  eventType: RequestLogEventType;
  attempt?: number;
  status?: number;
  retryable?: boolean;
  message?: string;
  createdAt: string;
}

export interface RequestLogCreateInput {
  requestId?: string;
  provider: ProviderId;
  route?: GatewayRoute;
  model?: string;
  sessionKey: string;
  accountId?: string;
  eventType: RequestLogEventType;
  attempt?: number;
  status?: number;
  retryable?: boolean;
  message?: string;
}

export interface RequestLogListInput {
  requestId?: string;
  provider?: ProviderId;
  accountId?: string;
  sessionKey?: string;
  status?: number;
  limit?: number;
  offset?: number;
}

export interface RequestLogStore {
  createRequestLog(input: RequestLogCreateInput): RequestLogRecord;
  listRequestLogs(input?: RequestLogListInput): RequestLogRecord[];
  clearRequestLogs(): number;
}

export class MemoryRequestLogStore implements RequestLogStore {
  private logs: RequestLogRecord[] = [];
  private nextId = 1;

  createRequestLog(input: RequestLogCreateInput): RequestLogRecord {
    const log = {
      ...input,
      requestId: input.requestId ?? crypto.randomUUID(),
      id: this.nextId,
      createdAt: new Date().toISOString(),
    };
    this.nextId += 1;
    this.logs.push(log);
    return { ...log };
  }

  listRequestLogs(input: RequestLogListInput = {}): RequestLogRecord[] {
    return filterRequestLogs(this.logs, input).map((log) => ({ ...log }));
  }

  clearRequestLogs(): number {
    const count = this.logs.length;
    this.logs = [];
    return count;
  }
}

export class SQLiteRequestLogStore implements RequestLogStore {
  private readonly db: Database;

  constructor(path = defaultDatabasePath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`
      create table if not exists request_logs (
        id integer primary key autoincrement,
        request_id text not null,
        provider text not null,
        route text,
        model text,
        session_key text not null,
        account_id text,
        event_type text not null,
        attempt integer,
        status integer,
        retryable integer,
        message text,
        created_at text not null
      );
    `);
    addColumnIfMissing(this.db, "request_logs", "request_id", "text not null default ''");
    this.db.exec(`
      create index if not exists idx_request_logs_created_at on request_logs(created_at);
      create index if not exists idx_request_logs_request_id on request_logs(request_id);
      create index if not exists idx_request_logs_provider on request_logs(provider);
      create index if not exists idx_request_logs_account_id on request_logs(account_id);
      create index if not exists idx_request_logs_session_key on request_logs(session_key);
    `);
  }

  createRequestLog(input: RequestLogCreateInput): RequestLogRecord {
    const createdAt = new Date().toISOString();
    const requestId = input.requestId ?? crypto.randomUUID();
    const result = this.db
      .query(
        `insert into request_logs (
          request_id, provider, route, model, session_key, account_id, event_type,
          attempt, status, retryable, message, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        requestId,
        input.provider,
        input.route ?? null,
        input.model ?? null,
        input.sessionKey,
        input.accountId ?? null,
        input.eventType,
        input.attempt ?? null,
        input.status ?? null,
        typeof input.retryable === "boolean" ? (input.retryable ? 1 : 0) : null,
        input.message ?? null,
        createdAt,
      );

    return {
      ...input,
      requestId,
      id: Number(result.lastInsertRowid),
      createdAt,
    };
  }

  listRequestLogs(input: RequestLogListInput = {}): RequestLogRecord[] {
    const conditions = [];
    const params: Array<string | number> = [];

    if (input.provider) {
      conditions.push("provider = ?");
      params.push(input.provider);
    }
    if (input.requestId) {
      conditions.push("request_id = ?");
      params.push(input.requestId);
    }
    if (input.accountId) {
      conditions.push("account_id = ?");
      params.push(input.accountId);
    }
    if (input.sessionKey) {
      conditions.push("session_key = ?");
      params.push(input.sessionKey);
    }
    if (typeof input.status === "number") {
      conditions.push("status = ?");
      params.push(input.status);
    }

    const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
    const offset = Math.max(0, input.offset ?? 0);
    const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const rows = this.db
      .query(`select * from request_logs ${where} order by created_at desc, id desc limit ? offset ?`)
      .all(...params, limit, offset) as RequestLogRow[];
    return rows.map(rowToRequestLog);
  }

  clearRequestLogs(): number {
    const result = this.db.query("delete from request_logs").run();
    return result.changes;
  }
}

function filterRequestLogs(
  logs: RequestLogRecord[],
  input: RequestLogListInput,
): RequestLogRecord[] {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
  const offset = Math.max(0, input.offset ?? 0);
  return logs
    .filter((log) => !input.provider || log.provider === input.provider)
    .filter((log) => !input.requestId || log.requestId === input.requestId)
    .filter((log) => !input.accountId || log.accountId === input.accountId)
    .filter((log) => !input.sessionKey || log.sessionKey === input.sessionKey)
    .filter((log) => typeof input.status !== "number" || log.status === input.status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
    .slice(offset, offset + limit);
}

interface RequestLogRow {
  id: number;
  request_id: string;
  provider: ProviderId;
  route?: GatewayRoute | null;
  model?: string | null;
  session_key: string;
  account_id?: string | null;
  event_type: RequestLogEventType;
  attempt?: number | null;
  status?: number | null;
  retryable?: number | null;
  message?: string | null;
  created_at: string;
}

function rowToRequestLog(row: RequestLogRow): RequestLogRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    provider: row.provider,
    route: row.route ?? undefined,
    model: row.model ?? undefined,
    sessionKey: row.session_key,
    accountId: row.account_id ?? undefined,
    eventType: row.event_type,
    attempt: row.attempt ?? undefined,
    status: row.status ?? undefined,
    retryable: typeof row.retryable === "number" ? row.retryable === 1 : undefined,
    message: row.message ?? undefined,
    createdAt: row.created_at,
  };
}

function addColumnIfMissing(
  db: Database,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  const columns = db.query(`pragma table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`alter table ${tableName} add column ${columnName} ${definition}`);
}
