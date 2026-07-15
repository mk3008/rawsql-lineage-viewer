select o.customer_id, sum(sl.shipped_amount) as shipped_amount from orders o join order_lines ol on ol.order_id = o.id join shipment_lines sl on sl.order_id = ol.order_id group by o.customer_id;
