"""Order persistence for the code-graph eval fixture."""


class OrderRepository:
    def find_by_id(self, order_id):
        return self._rows.get(order_id)


def summarize_orders(orders):
    return len(orders)
