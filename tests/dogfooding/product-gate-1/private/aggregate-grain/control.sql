select order_id, sum(amount) from order_items group by order_id;
