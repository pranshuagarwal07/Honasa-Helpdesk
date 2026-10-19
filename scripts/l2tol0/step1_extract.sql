-- L2toL0 step 1 (E, "Root WMS DB").
-- One row per SAR L2 quant that can be converted to base-SKU L0 in a single inventory update.
-- A bin is skipped (and picked up by a later run) when the converted stock would break the bin's
-- multiSku / multiBatch rule against whatever else is in it: PRE-GRN, PUT/PICK-locked or other stock.
WITH l2 AS (
    SELECT i."whId", i."binId", i."binCode", i."huId", i."skuId"::uuid AS sku_id, i."skuCode",
           i.batch, i."manufactureDate", i."expiryDate", i.bucket, i.qty
    FROM inventory i
    WHERE i."areaCode"        = 'SAR'
      AND i."whId"            = '1662652404097787'
      AND i."deletedAt"      IS NULL
      AND i."binStatus"       = 'ACTIVE'
      AND i.uom               = 'L2'
      AND i."inclusionStatus" = 'INCLUDED'
      AND i."quantLockMode"   = 'NONE'
      AND COALESCE(i."huCountBlocked", false) = false
      AND i.qty > 0
      AND UPPER(TRIM(i.batch)) ~ '^[0-9]{2}(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[0-9]+$'
),
conv AS (
    SELECT l2.*, bs.id AS base_id, bs.code AS base_sku, u.units AS case_size
    FROM l2
    JOIN encarta.skus s  ON s.id = l2.sku_id
    JOIN encarta.skus bs ON bs.id = s.base_sku_id
    JOIN LATERAL (SELECT units FROM encarta.uoms u
                  WHERE u.sku_id = s.id AND u.hierarchy = 'L2' AND u.active AND u.units > 1
                  LIMIT 1) u ON true
),
-- every (sku, batch) the bin will hold after the update: untouched quants + the new base-SKU L0
after_state AS (
    SELECT b.id AS bin_id, q."skuId" AS sku_id, q.batch
    FROM storage_bin b
    JOIN handling_unit hu       ON hu.id = b."binHuId" OR hu."storageId" = b."binHuId"
    JOIN handling_unit_quant q  ON q."huId" = hu.id AND q.qty <> 0
    WHERE b.id IN (SELECT "binId" FROM conv)
      AND NOT EXISTS (SELECT 1 FROM conv c                       -- the L2 quants being converted
                      WHERE c."binId" = b.id AND c.sku_id = q."skuId" AND c.batch = q.batch AND c.bucket = q.bucket
                        AND q.uom = 'L2' AND q."lockMode" = 'NONE' AND q."inclusionStatus" = 'INCLUDED')
    UNION
    SELECT "binId", base_id, batch FROM conv
),
-- the deduction must zero those quants, otherwise case-SKU stock stays next to the base-SKU L0
fully_converted AS (
    SELECT c."binId", c.sku_id, c.batch, c.bucket
    FROM conv c
    JOIN storage_bin b          ON b.id = c."binId"
    JOIN handling_unit hu       ON hu.id = b."binHuId" OR hu."storageId" = b."binHuId"
    JOIN handling_unit_quant q  ON q."huId" = hu.id AND q."skuId" = c.sku_id AND q.batch = c.batch AND q.bucket = c.bucket
                               AND q.uom = 'L2' AND q."lockMode" = 'NONE' AND q."inclusionStatus" = 'INCLUDED'
    GROUP BY c."binId", c.sku_id, c.batch, c.bucket, c.qty
    HAVING SUM(q.qty) = c.qty
),
ok_bins AS (
    SELECT a.bin_id
    FROM after_state a
    JOIN storage_bin b ON b.id = a.bin_id
    GROUP BY a.bin_id, b."multiSku", b."multiBatch"
    HAVING (COALESCE(b."multiSku", false)   OR COUNT(DISTINCT a.sku_id) <= 1)
       AND (COALESCE(b."multiBatch", false) OR COUNT(DISTINCT a.sku_id::text || '|' || a.batch) <= COUNT(DISTINCT a.sku_id))
       AND a.bin_id NOT IN (SELECT c."binId" FROM conv c
                            WHERE NOT EXISTS (SELECT 1 FROM fully_converted f
                                              WHERE f."binId" = c."binId" AND f.sku_id = c.sku_id
                                                AND f.batch = c.batch AND f.bucket = c.bucket))
)
SELECT c."whId", c."binCode", c."skuCode", c.base_sku, c.batch,
       c."manufactureDate", c."expiryDate", c.bucket, c.qty, c.case_size
FROM conv c
WHERE c."binId" IN (SELECT bin_id FROM ok_bins)
ORDER BY c."binCode"
LIMIT 100;   -- keep each run to one API call (200 payload rows)
