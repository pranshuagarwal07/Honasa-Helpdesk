-- WMS db. One row per OBD line: what WMS created + what was picked (qty in WMS uom and in eaches).
-- $1 = whId, $2 = SO numbers (text[]). All orders on the same shipments are read so picks are split correctly.
-- Picked qty comes from first-leg pick items of OUTBOUND_PICK tasks for the shipment, summed per base product,
-- then handed out to the shipment's OBD lines of that product in SO-line order.
with dl as (
  select o."orderReferenceCode"                        as so,
         -- 900005_000100, 900005_000100_S (split part) or 000100 -> SO line 10; null lineCode -> null
         (regexp_match(li."lineCode", '(\d{6})(?:_S)?$'))[1]::int / 10 as so_line,
         o.code                                         as do_no,
         o."tripCode"                                   as shipment,
         s.code                                         as wms_sku,
         coalesce(b.code, s.code)                       as product,
         li.uom                                         as wms_uom,
         li.batch                                       as wms_batch,
         li.qty                                         as obd_qty,
         li.qty * coalesce(u.units, 1)                  as obd_ea,
         li."deactivatedAt" is null                     as active,
         li."deactivationReason"                        as deactivation_reason,
         li."lineCode"                                  as line_code
  from ob_order o
  join ob_order_lineitem li on li."orderId" = o.id
  join encarta.skus s on s.id = li."skuId"
  left join encarta.skus b on b.id = s.base_sku_id
  left join lateral (select units from encarta.uoms u where u.sku_id = s.id and u.hierarchy = li.uom and u.active limit 1) u on true
  where o."whId" = $1
    and o."tripCode" in (select x."tripCode" from ob_order x where x."whId" = $1 and x."orderReferenceCode" = any($2::text[]))
),
pk as (
  select t.attrs ->> 'tripCode'                         as shipment,
         coalesce(b.code, s.code)                       as product,
         sum(pi."pickedQty" * coalesce(u.units, 1))     as picked_ea,
         string_agg(distinct pi.batch, ',')             as picked_batches
  from task t
  join pd_pick_item pi on pi."taskId" = t.id
  join encarta.skus s on s.id = pi."skuId"
  left join encarta.skus b on b.id = s.base_sku_id
  left join lateral (select units from encarta.uoms u where u.sku_id = s.id and u.hierarchy = pi.uom and u.active limit 1) u on true
  where t."whId" = $1 and t.kind = 'OUTBOUND_PICK'
    and pi."legIndex" = 0 and pi."deactivatedAt" is null and coalesce(pi."pickedQty", 0) > 0
    and t.attrs ->> 'tripCode' in (select distinct shipment from dl)
  group by 1, 2
),
cum as (
  select dl.*,
         coalesce(sum(case when active then obd_ea end) over (partition by shipment, product order by so, so_line nulls last, line_code
                  rows between unbounded preceding and 1 preceding), 0) as before_ea
  from dl
)
select c.so, c.so_line, c.do_no, c.shipment, c.wms_sku, c.product, c.wms_uom, c.wms_batch, c.obd_qty, c.obd_ea,
       c.active, c.deactivation_reason, c.line_code,
       case when c.active then least(c.obd_ea, greatest(0, coalesce(pk.picked_ea, 0) - c.before_ea)) else 0 end as picked_ea,
       pk.picked_batches
from cum c
left join pk on pk.shipment = c.shipment and pk.product = c.product
where c.so = any($2::text[])
order by c.so, c.so_line nulls last, c.do_no
