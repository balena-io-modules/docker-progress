* Do not export getRegistryAndName and use docker-toolbelt instead

# v2.3.0

* Updated to bluebird 3
* Updated to lodash v4
* Updated to coffee-script 1.11

# v2.2.0

* Support pulling from registry v2
* Correctly handle progress during concurrent push.
* Added linting.

# v2.1.0

* Correctly handle progress during concurrent pulls.

# v2.0.1

* Use 443 as the default registry port.

# v2.0.0

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
