"""SQLAlchemy query call sites + a raw psycopg statement — fixture for #898."""

from sqlalchemy import select, update, delete

from .models import User, orders


def list_users(session):
    return session.query(User).all()


def find_user_email(session):
    return session.query(User.email).all()


def deactivate_user(session):
    session.execute(update(User).where(User.id == 1))


def purge_user(session):
    session.execute(delete(User).where(User.id == 1))


def list_orders(conn):
    return conn.execute(select(orders)).fetchall()


def add_order(conn):
    conn.execute(orders.insert().values(total=10))


def audit(cursor):
    # Raw psycopg — reaches the schema graph via the sqlglot sidecar path, not
    # the SQLAlchemy resolver.
    cursor.execute("SELECT id, action FROM audit_log WHERE user_id = %s", (1,))
