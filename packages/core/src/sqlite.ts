import BetterSqlite3, {
  type Database as BetterSqliteDatabase,
  type Statement,
} from "better-sqlite3";

export class Database {
  private readonly db: BetterSqliteDatabase;

  constructor(path: string) {
    this.db = new BetterSqlite3(path);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  query<BindParameters extends unknown[] | object = unknown[]>(
    sql: string,
  ): Statement<BindParameters> {
    return this.db.prepare(sql) as Statement<BindParameters>;
  }

  close(): void {
    this.db.close();
  }
}
