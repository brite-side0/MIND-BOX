import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Records the SQL passed to the query builder so we can assert which catalog
// path (plain vs. full-text) listCatalog took, without a real database.
let currentRows: unknown[] = [];
const calls: { where: unknown[]; orderBy: unknown[][] } = { where: [], orderBy: [] };

const builder: Record<string, (...args: unknown[]) => unknown> = {
  from: () => builder,
  innerJoin: () => builder,
  where: (arg: unknown) => {
    calls.where.push(arg);
    return builder;
  },
  orderBy: (...args: unknown[]) => {
    calls.orderBy.push(args);
    return Promise.resolve(currentRows);
  },
};

vi.mock("../db/client.js", () => ({ db: { select: () => builder } }));
vi.mock("../storage/supabaseStorage.js", () => ({ uploadFile: vi.fn(), deleteFile: vi.fn() }));
vi.mock("../config.js", () => ({ config: { CATALOG_CACHE_TTL_MS: 60_000 } }));

import {
  listCatalog,
  __resetCatalogCache,
  normalizeSearchTerm,
  buildSearchPredicate,
  buildSearchRank,
} from "./resourceService.js";

const dialect = new PgDialect();
const render = (s: SQL) => dialect.sqlToQuery(s);
const renderAll = (args: unknown[]): string => args.map((a) => render(a as SQL).sql).join(" ");

describe("normalizeSearchTerm", () => {
  it("returns undefined for an absent term", () => {
    expect(normalizeSearchTerm(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(normalizeSearchTerm("")).toBeUndefined();
  });

  it("returns undefined for a whitespace-only string", () => {
    expect(normalizeSearchTerm("   \t\n ")).toBeUndefined();
  });

  it("trims surrounding whitespace from a normal term", () => {
    expect(normalizeSearchTerm("  stellar  ")).toBe("stellar");
  });

  it("caps an over-length term at 200 characters", () => {
    const result = normalizeSearchTerm("a".repeat(500));
    expect(result).toHaveLength(200);
  });
});

describe("FTS SQL builders", () => {
  it("builds a websearch tsvector match predicate and binds the term as a parameter", () => {
    const { sql, params } = render(buildSearchPredicate("stellar network"));

    expect(sql).toContain("websearch_to_tsquery");
    expect(sql).toContain("@@");
    expect(sql).toContain("search_vector");
    // Injection-safe: the term is a bound parameter, never interpolated into SQL.
    expect(params).toContain("stellar network");
    expect(sql).not.toContain("stellar network");
  });

  it("builds a ts_rank relevance expression and binds the term as a parameter", () => {
    const { sql, params } = render(buildSearchRank("stellar"));

    expect(sql).toContain("ts_rank");
    expect(sql).toContain("websearch_to_tsquery");
    expect(params).toContain("stellar");
    expect(sql).not.toContain("'stellar'");
  });
});

describe("listCatalog query path selection", () => {
  beforeEach(() => {
    __resetCatalogCache();
    currentRows = [];
    calls.where = [];
    calls.orderBy = [];
  });

  it("takes the FTS path when a search term is present (ranks by ts_rank, matches search_vector)", async () => {
    await listCatalog({ search: "stellar" });

    const orderBySql = renderAll(calls.orderBy.at(-1) ?? []);
    expect(orderBySql).toContain("ts_rank");

    const whereSql = calls.where.map((w) => render(w as SQL).sql).join(" ");
    expect(whereSql).toContain("websearch_to_tsquery");
  });

  it("takes the plain path (no FTS) when no search term is given", async () => {
    await listCatalog();

    const orderBySql = renderAll(calls.orderBy.at(-1) ?? []);
    expect(orderBySql).not.toContain("ts_rank");
    expect(orderBySql).toContain("created_at");
  });

  it("treats a whitespace-only search as no search (plain path)", async () => {
    await listCatalog({ search: "   " });

    const orderBySql = renderAll(calls.orderBy.at(-1) ?? []);
    expect(orderBySql).not.toContain("ts_rank");
  });
});
