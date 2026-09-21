package com.example.mapper;

import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Update;
import org.apache.ibatis.annotations.Delete;

public interface OrderMapper {

    @Select("SELECT id, total, status FROM shop.orders WHERE id = #{id}")
    Order findById(long id);

    @Insert("INSERT INTO shop.orders (customer_id, total, status) VALUES (#{customerId}, #{total}, #{status})")
    int insert(Order order);

    @Update("UPDATE shop.orders SET status = #{status} WHERE id = #{id}")
    int updateStatus(long id, String status);

    @Delete("DELETE FROM shop.orders WHERE id = #{id}")
    int deleteById(long id);
}
