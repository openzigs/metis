package org.example.dao;

import static org.jooq.example.db.public_.tables.Book.BOOK;

import java.util.List;
import org.jooq.DSLContext;
import org.jooq.Record;

public class BookDao {

    public List<Record> findAllBooks(DSLContext ctx) {
        return ctx.select().from(BOOK).fetch();
    }

    public void createBook(DSLContext ctx, String title) {
        ctx.insertInto(BOOK).columns(BOOK.TITLE).values(title).execute();
    }

    public void renameBook(DSLContext ctx, Long id, String title) {
        ctx.update(BOOK).set(BOOK.TITLE, title).where(BOOK.ID.eq(id)).execute();
    }

    public void deleteBook(DSLContext ctx, Long id) {
        ctx.deleteFrom(BOOK).where(BOOK.ID.eq(id)).execute();
    }
}
