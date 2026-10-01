---
name: sillo-storage
title: File storage & uploads
description: >-
  Storing files with sillo.storage: buckets, local and memory drivers, access policies
  (Private, Public, Owned, ReadOnly, Signed), streaming uploads, signed URLs and serving,
  and what to do for S3 in 1.0.
intents:
  - upload these files to S3
  - let users upload an avatar
  - store uploaded documents
  - give a temporary download link
  - serve user files securely
  - limit uploads to images under 2 MB
capabilities: [storage, file_uploads]
related: [sillo-validation, sillo-requests, sillo-auth, sillo-responses]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: [sillo-framework]
symbols:
  - sillo.storage.setup_storage
  - sillo.storage.StorageConfig
  - sillo.storage.BucketConfig
  - sillo.storage.StorageInstallable
  - sillo.storage.bucket
  - sillo.storage.Bucket
  - sillo.storage.Bucket.put
  - sillo.storage.Bucket.get
  - sillo.storage.Bucket.stat
  - sillo.storage.Bucket.signed_url
  - sillo.storage.stream_upload
  - sillo.storage.chunks
  - sillo.storage.collect
  - sillo.storage.Private
  - sillo.storage.Public
  - sillo.storage.Owned
  - sillo.storage.Driver
  - sillo.storage.PolicyRefused
probes:
  - storage_local_bucket_put_get_stat_and_policy
  - storage_rejects_unsafe_keys
  - s3_driver_is_not_implemented_in_1_0_0
  - custom_driver_bucket_can_be_added_to_storage
  - owned_policy_with_user_stream_upload_and_signed_put_gap
  - uploads_are_uploadedfile_in_a_dict_and_form_markers_bind
sources:
  - core:sillo/storage/storage.py
  - core:sillo/storage/bucket.py
  - core:sillo/storage/policies.py
  - core:sillo/storage/config.py
  - core:sillo/storage/base.py
  - core:sillo/storage/uploads.py
  - docs:v1.0/guides/storage.mdx
status: stable
---

## When

Saving files: user uploads, generated exports, attachments; serving them back with
access control; temporary download/upload URLs. Reading the upload from the request is
`sillo-requests` / `sillo-validation`.

## Inspect first

- Existing `setup_storage` / `StorageInstallable` config and bucket names.
- Where files should live (local disk vs object storage) and who may read them.
- The secret used for signing (`StorageConfig(secret=...)`, else the app's secret).

## How

```python
from sillo.storage import BucketConfig, Owned, Private, StorageConfig, setup_storage

storage = setup_storage(app, StorageConfig(
    default="documents",
    secret=settings.secret_key,                      # signs URLs
    buckets={
        "documents": BucketConfig(driver="local", root="storage/documents", policy=Private()),
        "avatars": BucketConfig(driver="local", root="storage/avatars", policy=Owned(),
                                accepts=("image/png", "image/jpeg"), max_bytes=2 * 1024 * 1024),
    },
))
```

**Policies apply to every operation, including your server code:**

| Policy | Allows |
|---|---|
| `Private()` (default) | nothing unless the call is `signed=True` or uses a signed URL |
| `Public()` | anyone reads; writes need `signed=True` |
| `Owned(prefix="{id}/")` | a user reads/writes under their own prefix (`user=ctx.user`) |
| `ReadOnly()` | authenticated users read; nobody writes |
| `Signed()` | signed reads only |

Pass `user=ctx.user` for user-scoped policies, or `signed=True` when *your code* is the
trusted party (a job generating an export).

**Uploading from a request** — stream, do not read into memory:

```python
from sillo import File, HttpContext
from sillo.storage import bucket, stream_upload

@router.post("/me/avatar", auth=useAuth())
async def upload_avatar(ctx: HttpContext, avatar=File()):
    stored = await bucket("avatars").put(
        f"{ctx.user.identity}/avatar", stream_upload(avatar),
        content_type=avatar.content_type or "", user=ctx.user,
    )
    return {"key": stored.key, "size": stored.size}
```

The stored content type is sniffed from the bytes; `accepts` and `max_bytes` are enforced.

**Reading and serving:**

```python
url = bucket("documents").signed_url(f"invoices/{invoice.id}.pdf", expires_in=300)   # GET link
data = await collect(bucket("documents").get(key, signed=True), limit=1_000_000)
info = await bucket("documents").stat(key, signed=True)
```

Buckets are served under `/storage/<bucket>/<key>` (`StorageConfig(route=, serve=True)`)
for **GET** only, honouring policies and signatures, so a signed GET URL works directly in
a browser; refusals answer 404 so they do not confirm a file exists. Signed **PUT** URLs
can be minted but nothing in 1.0.0 accepts them — upload through your own endpoint. `bucket(name)`
works in handlers, jobs and scripts. More (listing, events, custom drivers):
[drivers.md](references/drivers.md).

**S3 in sillo-framework 1.0.0:** there is no S3 driver — `BucketConfig(driver="s3", …)`
raises even with `sillo-framework[storage-s3]` installed. Either implement a
`sillo.storage.Driver` for S3 (declare the bucket with `driver="memory"`, then replace
`storage.buckets[name]` with a `Bucket(name, YourS3Driver(), policy=...)`), or use an S3
client (aioboto3) directly. Tell the user which you chose and why.

## Compose

Upload validation markers — `sillo-validation`. Access control — `sillo-auth`.
Streaming responses — `sillo-responses`. Generating exports in the background —
`sillo-queues` (write with `signed=True`).

## Verify

In tests use `BucketConfig(driver="memory")`; assert `put` returns the key and size, a
second user is refused under `Owned()` (`PolicyRefused`), and a signed URL downloads
(`client.get(url)`) while the unsigned path is refused.

## Avoid

- Calling `put/get/stat` on a `Private()` bucket without `signed=True` or a user: every
  call raises `PolicyRefused`, even from server code.
- Building keys from raw user input: use ids; keys are normalised and `../` is rejected
  (`UnsafeKey`).
- `await upload.read()` for large files; use `stream_upload`.
- Serving user uploads inline with `file(...)`; use signed URLs or `download(...)`.
- Assuming an S3 driver exists in 1.0.0.
