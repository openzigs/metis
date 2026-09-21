"""SQLAlchemy models fixture for #898 — ORM declarative class + Core Table."""

from sqlalchemy import Column, Integer, String, Table, MetaData
from sqlalchemy.orm import declarative_base

Base = declarative_base()
metadata = MetaData()


class User(Base):
    __tablename__ = "users"
    __table_args__ = {"schema": "crm"}

    id = Column(Integer, primary_key=True)
    email = Column("email_address", String)
    display_name = Column(String)


class AbstractMixin:
    # No __tablename__ — a mixin, not a physical table. Must be skipped.
    created_at = Column(Integer)


orders = Table(
    "orders",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("total", Integer),
    schema="sales",
)
