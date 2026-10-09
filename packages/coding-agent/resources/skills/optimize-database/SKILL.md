---
name: optimize-database
description: "Use to diagnose and optimize database performance: analyze query execution plans (EXPLAIN ANALYZE), design indexing strategies, tune concurrency, and execute zero-downtime migrations."
---

# Skill: optimize-database

## When to Use
Apply this skill when diagnosing slow database queries, resolving connection pool bottlenecks, tuning table schemas, or executing high-volume production migrations.

## Database Optimization Procedure

1. **Analyze Query Execution Plans**:
   - Run `EXPLAIN (ANALYZE, BUFFERS)` to inspect query performance.
   - Identify sequential scans on large tables, expensive sorts, nested loop blowups, and high buffer reads.

2. **Design Targeted Indexing Strategies**:
   - Create B-Tree indexes matching filter equality and range predicates, join keys, and sort orders.
   - Use partial/filtered indexes for queries targeting specific record subsets.
   - Avoid redundant indexes and evaluate write-amplification overhead on high-throughput tables.

3. **Eliminate Query Anti-Patterns**:
   - Eliminate N+1 queries using eager loading or batch queries.
   - Replace `SELECT *` with explicit column projections.
   - Ensure `WHERE` clauses are sargable: avoid wrapping indexed columns in functions (e.g., `WHERE LOWER(email) = ...`).

4. **Execute Zero-Downtime Migrations**:
   - Follow the Expand-Contract pattern for breaking schema evolutions.
   - Use concurrent index creation (`CREATE INDEX CONCURRENTLY`) to avoid blocking table locks.
   - Backfill data in small, rate-limited chunks during off-peak hours.
