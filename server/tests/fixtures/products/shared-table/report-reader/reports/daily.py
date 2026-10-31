# Synthetic fixture for #1619 — not production content, never executed.
# The report reader only reads the orders table the order writer writes.

DAILY_TOTALS = "SELECT customer_id, SUM(total) FROM orders GROUP BY customer_id"

# Not SQL: a sentence that happens to contain "from".
HELP_TEXT = "Totals come from the order writer every night"


def daily_totals(cursor):
    cursor.execute(DAILY_TOTALS)
    return cursor.fetchall()
