# Storage: listing, events and custom drivers

## Listing

```python
cursor = ""
while True:
    page = await bucket("reports").page("invoices/", cursor=cursor, limit=100, user=ctx.user)
    for info in page.files:
        print(info.key, info.size, info.content_type)
    if not page.more:
        break
    cursor = page.cursor
```

`page.prefixes` lists "sub-directories" under the prefix. `page()` has no `signed=`
option: listing is allowed only by the policy (`Public`, `ReadOnly` or `Owned` with a
user), so a `Private()` bucket cannot be listed.

## File info

`FileInfo`: `key`, `size`, `content_type` (sniffed), `declared_type` (what the uploader
claimed), `mistyped`, `modified`, `etag`. `await bucket.exists(key, ...)`,
`await bucket.delete(key, ...)`.

## Audit events

```python
@storage.listen
def audit(event):
    logger.info("%s %s/%s %s %.1fms", event.action, event.bucket, event.key, event.outcome, event.duration_ms)
```

## Signed upload URLs

`bucket.signed_url(key, method="PUT", content_type=, max_bytes=)` mints a token, but the
built-in `/storage` route only serves GET in sillo-framework 1.0.0, so a browser PUT to it
returns 405. For direct uploads, add your own endpoint that authenticates the user and
streams the body into the bucket (`put(key, ctx.stream-style iterator, user=...)`), or
accept multipart uploads with `File()` and `stream_upload`.

## A custom driver (S3, GCS, Azure)

Subclass `sillo.storage.Driver` and implement the async operations the bucket calls:

```python
from sillo.storage import Driver, FileInfo, Page, Stored


class S3Driver(Driver):
    name = "s3"

    def __init__(self, client, bucket_name: str) -> None:
        super().__init__()
        self.client, self.bucket_name = client, bucket_name

    async def write(self, key, stream, *, content_type="", declared_type=""):
        ...            # upload the async byte stream (multipart for large files) → Stored
    def read(self, key):
        ...            # return an async iterator of bytes
    async def stat(self, key) -> FileInfo: ...
    async def delete(self, key) -> bool: ...
    async def page(self, prefix="", *, cursor="", limit=100) -> Page: ...
    async def close(self) -> None: ...
```

Read `sillo/storage/base.py` in the installed framework for the exact signatures and the
events a driver should emit, and `sillo/storage/drivers/local.py` as a reference
implementation. Register it:

```python
from sillo.storage import Bucket, BucketConfig, Private, StorageConfig, setup_storage

storage = setup_storage(app, StorageConfig(
    default="uploads", secret=settings.secret_key,
    buckets={"uploads": BucketConfig(driver="memory")},     # declares the name
))
storage.buckets["uploads"] = Bucket("uploads", S3Driver(s3_client, "my-bucket"), policy=Private())
```

`bucket("uploads")` then routes through your driver, with policies, signing and the
`/storage` route unchanged.
