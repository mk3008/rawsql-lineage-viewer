select customer_id,sum(amount) from payments where status='success' group by customer_id;
