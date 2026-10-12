# [Bug]: After "Mark this page as read" the feed shows 0 entries

### Bug Summary

If I navigate to the last page of a multipage feed and mark the page as read, it show zero entries afterwards

### Description

On a feed with multiple pages, while being on the last page and marking it as read, the feed gets blank and the name of the field is shown with (0) afterwards.

### Steps to Reproduce

1. Go to a feed with multiple pages (let's say 300 unread entries) having miniflux configured with 20 entries per page.
2. Press Last to go to the last page, note the feed name on top followed by 300 between brackets.
3. Press "Mark this page as read"
4. Note that the feed shows no entries, there is no Prev button, the feed name is followed by 0 between brackets. *Exactly* like an empty feed.

### Expected Behavior

Should have moved to the previous page, as marking a page as read moves to the next. But if we mark as read the last page, it should move to the previous.

### Actual Behavior

It shows "No unread entries", name of the feed is followed by (0) and there is no Previous navigation button, although there are obviously entries in the feed.

### Version

2.3.1

### Browser

Chrome

### Additional Context

I am conflicted, on one hand marking page as read should move to the next page, which it does. But I guess we can break the rule when we mark the last page as read and move not to the next (as there is no next) but to the previous.
Or, if always move next is a design requirement, at least miniflux should not scare the user saying that there are zero unread entries in the feed. And let the Previous button there ;)

Thank you for Miniflux!
