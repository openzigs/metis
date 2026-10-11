# [Bug]: Reader API /stream/items/ids count is always 1000 on 2.3.3

### Bug Summary

Reader API /stream/items/ids count is always 1000 on 2.3.3

### Description

For the google reader api '/stream/items/ids', my rss reader used this api to fetch all unread article ids. 
However, after I updating to 2.3.3, it always return 1000 ids if n is omitted. The previous versions worked fine.

As per the google reader api doc: if n is omitted, the query is effectively unbounded. So I think it should return more than 1000 ids if I have more than 1000 unread articles.

https://github.com/miniflux/v2/blob/main/internal/googlereader/README.md

### Steps to Reproduce

call google reader api: /stream/items/ids, and parameter 'n' is omitted.

### Expected Behavior

get more than 1000 ids if I have more than 1000 unread articles.

### Actual Behavior

only have 1000 ids.

### Version

2.3.3
