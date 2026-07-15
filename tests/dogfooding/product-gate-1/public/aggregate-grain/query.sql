select o.customer_id, sum(oi.amount) as item_amount from orders o join order_items oi on oi.order_id=o.id group by o.customer_id;
