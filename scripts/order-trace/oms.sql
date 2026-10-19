-- OMS db. One row per SO line: what SAP pushed + what OMS allocated (all qty in eaches).
-- $1 = node id (text), $2 = SO numbers without the "SO" prefix (text[]) or null, $3/$4 = ord.created_at range (UTC) when $2 is null
select substring(o.code from 3)                    as so,
       o.customer,
       o.placed_at,
       o.created_at                                as pushed_at,
       (regexp_match(l.code, '-(\d+)$'))[1]::int as so_line, -- SO1291029145-3 / SO1291029145-1-3 -> 3
       l.product,
       l.uom                                       as sap_uom,
       l.qty                                       as sap_qty_ea,
       ls.state                                    as oms_state,
       coalesce(ls.allocated_qty, 0)               as oms_alloc_ea,
       (select string_agg(a.sku || ' / ' || a.batch || ' / ' || a.qty, '; ' order by a.sku, a.batch)
          from allocation_line a where a.line_id = l.id and a.active) as oms_alloc_detail
from ord o
join line l on l.order_id = o.id
left join line_state ls on ls.line_id = l.id and ls.active
where o.node_id = $1
  and (case when $2::text[] is not null then substring(o.code from 3) = any($2::text[])
            else o.created_at >= $3::timestamp and o.created_at < $4::timestamp end)
order by 1, 5
