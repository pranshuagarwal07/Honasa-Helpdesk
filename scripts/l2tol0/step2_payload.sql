-- L2toL0 step 2 (T, SQLite over Table_1).
-- Deduct row (case SKU, L2) + add row (base SKU, L0) for every quant, sent together in ONE call:
-- the storage API checks bin rules on the final state and rolls back the whole call on any error,
-- so a bin is either fully converted or left untouched.
SELECT "whId", "binCode" AS "bin", "skuCode" AS "sku", "batch" AS "batchCode",
       "manufactureDate", "expiryDate", -1 * "qty" AS "qty", 'L2' AS "uom",
       "bucket", 'INCLUDED' AS "inclusionStatus", 'APPEND' AS "opType"
FROM Table_1
UNION ALL
SELECT "whId", "binCode", "base_sku", "batch",
       "manufactureDate", "expiryDate", "qty" * "case_size", 'L0',
       "bucket", 'INCLUDED', 'APPEND'
FROM Table_1;
