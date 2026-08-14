# X/Twitter app map (as of Aug 2026, Pixel 9)

Package: `com.twitter.android`. Everything below is semantic — coordinates drift with
screen size and app updates; re-derive from `puppet_screen` each session.

## Layout

- **Bottom nav** (no Profile tab): Home, Explore, Grok, Notifications tab, Messages.
- **Top-left avatar** = `contentDesc "Show navigation drawer"` → opens the side drawer.
  - Drawer items: Profile, Premium, Communities, Bookmarks, Lists, Spaces, Creator
    Studio, Settings and privacy, Help Centre. Items are text nodes inside clickable
    rows; tap by text.
  - Close: `contentDesc "Close navigation menu"` (top-right), or `puppet_key back`.
- **Feed tabs** (home): "For you" / "Following" + topic chips — horizontally scrollable.
  - "Scroll to top" button appears in the header when scrolled.
- **Floating Post button**: bottom-right, `contentDesc "Post"` (~x 900-1080, y ~2000-2200).
- **Composer**: opens after tapping Post. Field hint "What's happening?" (tappable,
  auto-focused). Send: "Post" button top-right. Row of attachments: Photos, Camera,
  Start a Space, GIF, Poll, Turn on Geo Tag, Content disclosure, Add a post.
- **Profile page**: header (name, @handle, bio, website, joined, following/followers)
  → possible upsell card ("You aren't verified yet" — dismissible via "Dismiss") →
  posts feed starting with the pinned post. Tabs: Posts, Replies, Reposts, Videos,
  Articles, Likes (horizontal scroll). Post count in the header ("1,899 posts").

## Reading posts

- Each post: author avatar (clickable), name, Verified badge (desc), @handle, time
  ("· 2m"), "Explain this post with Grok" (desc, top-right), "Post options" (desc,
  the … menu), then the post text (single node, may contain `\n`), optional Image
  (desc, clickable), Quote block, then the engagement row:
  Reply / Repost / Like / Impressions / Bookmark / Share — each a clickable container
  with a desc child and a count text beside it.
- Post options (…) sheet: Pin to profile, Content disclosure, **Delete post**,
  Change who can reply, Request Community Note, Edit with Premium, View Hidden Replies.
  Bottom sheet — the dump will show ONLY the sheet while open.
- Delete confirm dialog: "Delete post?" / "This can't be undone…" / Cancel / Delete.

## Common flows (semantic steps)

**Post:**
1. `puppet_launch` com.twitter.android; `puppet_wait` for feed text.
2. `puppet_tap` on the floating button (contentDesc "Post" or coords).
3. `puppet_wait` for "What's happening?".
4. `puppet_type` the text.
5. `puppet_tap` the composer's "Post" button (top-right).
6. `puppet_wait` for a feed anchor → "Sending post…" appears then disappears (its
   disappearance is the send-complete signal); verify the post text on screen.

**Open my profile:**
1. `puppet_tap` `contentDesc "Show navigation drawer"`.
2. `puppet_wait` "Profile"; `puppet_tap` text "Profile".
3. `puppet_wait` for "@handle" of the account.

**Delete a post (mine):**
1. Profile → Posts tab (active by default).
2. Scroll (`puppet_swipe` up) until the post text is in the dump.
3. `puppet_tap` its "Post options" (…, top-right of the post — nearest one above the
   matching text).
4. `puppet_tap` "Delete post" in the sheet; `puppet_tap` "Delete" in the dialog.
5. Confirm: the post text must no longer match (`puppet_wait` for it will time out).

## Gotchas seen in the wild

- The **For You home feed re-ranks**: your own post can vanish from the top seconds
  after posting. For anything about your own content, use the profile, not the feed.
- A tap near the screen edge can scroll the feed instead of pressing a button —
  re-dump and verify state after every tap that "did nothing".
- The feed tab chips and profile tab rows are horizontal scrollers: the active tab
  may be off-viewport. Tap the tab label text, not a position.
- Post text nodes are clickable=false children; the clickable container is a parent
  view. Tapping by the text still works (gesture fallback) — expect
  `"method":"gesture"` in the result.
- The "…" options buttons of different posts share the same `contentDesc "Post
  options"`; disambiguate by position: pick the one whose y is just above the post
  text you matched.
