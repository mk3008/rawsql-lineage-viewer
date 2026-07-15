select o.customer_id, sum(sl.shipped_amount) from orders o join order_lines ol on ol.order_id=o.id join shipment_lines sl on sl.order_id=ol.order_id and sl.line_no=ol.line_no group by o.customer_id;
