* Add toString() to Registry class and export getRegistryAndName().
* Changed pull/push to fall back to calling onProgress without `downloadedSize`, `totalSize`, and `percentage` in the case where fetching size info fails, rather than failing with an error.
* Fix a race condition where early layers could complete before we had completed fetching all the layer sizes, meaning it would not be accounted for in `downloadedSize` and `percentage`.

# v1.1.2

* Capped reported percentage at 100.

# v1.1.1

* Fix registry references in errors.

# v1.1.0

* Added support for listing total progress of a docker push.

# v1.0.0

* Added support for listing total progress of a docker pull.