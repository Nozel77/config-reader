// Extracted from server.js — the provider id these tools get pointed at.
'use strict';

// The provider id these tools get pointed at. Kept as 9router rather than something
// neutral so a config another 9router install already wrote is edited in place
// instead of gaining a second, competing provider entry.
const PROVIDER = '9router';
const PROVIDER_LABEL = '9Router';

module.exports = { PROVIDER, PROVIDER_LABEL };
