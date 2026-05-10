import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AccountKind } from "./accounts";
import { defaultDatabasePath } from "./accounts";
import type { ProviderId } from "./index";
import { Database } from "./sqlite";

export type StickySessionKind = AccountKind | "any" | "codex_session" | "prompt_cache";

export interface StickySessionRecord {
  key: string;
  provider: ProviderId;
  kind: StickySessionKind;
  sessionKey: string;
  accountId: string;
  createdAt: string;
  updatedAt: string;
}

export interface StickySessionUpsertInput {
  key: string;
  provider: ProviderId;
  kind: StickySessionKind;
  sessionKey: string;
  accountId: string;
}

export interface StickySessionRegistry {
  listStickySessions(): StickySessionRecord[];
  deleteStickySession(key: string): boolean;
  clearStickySessions(): number;
  purgeStickySessions(input?: StickySessionPurgeInput): number;
}

export interface StickySessionStore extends StickySessionRegistry {
  getStickySession(key: string): StickySessionRecord | undefined;
  upsertStickySession(input: StickySessionUpsertInput): StickySessionRecord;
}

export interface StickySessionPurgeInput {
  maxAgeSeconds?: number;
  provider?: ProviderId;
  kind?: StickySessionKind;
  accountId?: string;
}

export class MemoryStickySessionStore implements StickySessionStore {
  private readonly sessions = new Map<string, StickySessionRecord>();

  listStickySessions(): StickySessionRecord[] {
    return [...this.sessions.values()]
      .map((session) => ({ ...session }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getStickySession(key: string): StickySessionRecord | undefined {
    const session = this.sessions.get(key);
    return session ? { ...session } : undefined;
  }

  upsertStickySession(input: StickySessionUpsertInput): StickySessionRecord {
    const existing = this.sessions.get(input.key);
    const now = new Date().toISOString();
    const session = {
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sessions.set(input.key, session);
    return { ...session };
  }

  deleteStickySession(key: string): boolean {
    return this.sessions.delete(key);
  }

  clearStickySessions(): number {
    const count = this.sessions.size;
    this.sessions.clear();
    return count;
  }

  purgeStickySessions(input: StickySessionPurgeInput = {}): number {
    const cutoffMs = Date.now() - Math.max(0, input.maxAgeSeconds ?? 7 * 24 * 60 * 60) * 1000;
    let deleted = 0;

    for (const session of this.sessions.values()) {
      if (input.provider && session.provider !== input.provider) continue;
      if (input.kind && session.kind !== input.kind) continue;
      if (input.accountId && session.accountId !== input.accountId) continue;
      if (new Date(session.updatedAt).getTime() > cutoffMs) continue;
      if (this.sessions.delete(session.key)) deleted += 1;
    }

    return deleted;
  }
}

export class SQLiteStickySessionStore implements StickySessionStore {
  private readonly db: Database;

  constructor(path = defaultDatabasePath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`
      create table if not exists sticky_sessions (
        key text primary key,
        provider text not null,
        kind text not null,
        session_key text not null,
        account_id text not null,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists idx_sticky_sessions_account_id on sticky_sessions(account_id);
      create index if not exists idx_sticky_sessions_provider on sticky_sessions(provider);
      create index if not exists idx_sticky_sessions_updated_at on sticky_sessions(updated_at);
    `);
  }

  listStickySessions(): StickySessionRecord[] {
    const rows = this.db
      .query("select * from sticky_sessions order by updated_at desc")
      .all() as StickySessionRow[];
    return rows.map(rowToStickySession);
  }

  getStickySession(key: string): StickySessionRecord | undefined {
    const row = this.db
      .query("select * from sticky_sessions where key = ?")
      .get(key) as StickySessionRow | null;
    return row ? rowToStickySession(row) : undefined;
  }

  upsertStickySession(input: StickySessionUpsertInput): StickySessionRecord {
    const existing = this.getStickySession(input.key);
    const now = new Date().toISOString();
    const session: StickySessionRecord = {
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.db
      .query(
        `insert into sticky_sessions (
          key, provider, kind, session_key, account_id, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)
        on conflict(key) do update set
          provider = excluded.provider,
          kind = excluded.kind,
          session_key = excluded.session_key,
          account_id = excluded.account_id,
          updated_at = excluded.updated_at`,
      )
      .run(
        session.key,
        session.provider,
        session.kind,
        session.sessionKey,
        session.accountId,
        session.createdAt,
        session.updatedAt,
      );

    return session;
  }

  deleteStickySession(key: string): boolean {
    const result = this.db.query("delete from sticky_sessions where key = ?").run(key);
    return result.changes > 0;
  }

  clearStickySessions(): number {
    const result = this.db.query("delete from sticky_sessions").run();
    return result.changes;
  }

  purgeStickySessions(input: StickySessionPurgeInput = {}): number {
    const cutoff = new Date(
      Date.now() - Math.max(0, input.maxAgeSeconds ?? 7 * 24 * 60 * 60) * 1000,
    ).toISOString();
    const conditions = ["updated_at <= ?"];
    const params: Array<string> = [cutoff];

    if (input.provider) {
      conditions.push("provider = ?");
      params.push(input.provider);
    }
    if (input.kind) {
      conditions.push("kind = ?");
      params.push(input.kind);
    }
    if (input.accountId) {
      conditions.push("account_id = ?");
      params.push(input.accountId);
    }

    const result = this.db
      .query(`delete from sticky_sessions where ${conditions.join(" and ")}`)
      .run(...params);
    return result.changes;
  }
}

interface StickySessionRow {
  key: string;
  provider: ProviderId;
  kind: StickySessionKind;
  session_key: string;
  account_id: string;
  created_at: string;
  updated_at: string;
}

function rowToStickySession(row: StickySessionRow): StickySessionRecord {
  return {
    key: row.key,
    provider: row.provider,
    kind: row.kind,
    sessionKey: row.session_key,
    accountId: row.account_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
