#
# Varnish VCL for images.ecency.com
# Deployed at /etc/varnish/user.vcl on the production server
#
# Request flow: Cloudflare -> Nginx (443) -> Varnish (6081) -> Docker imagehoster (8800)
#
# What Varnish caches:
#   - /u/* (avatars/covers) — small (~2KB), frequently requested
#   - ?blur= URLs — small (~2KB) blur placeholders
# What passes through:
#   - /p/* proxy images — large, long-tail, cached by Cloudflare instead
#   - /DQm* uploads — served from S3, cached by Cloudflare
#   - ?invalidate= requests — ban cached URL + pass to backend
#   - ?ignorecache= requests — bypass cache
#

vcl 4.1;

backend default {
    .host = "0.0.0.0";
    .port = "8800";
    .probe = {
        .url = "/";
        .timeout = 40ms;
        .interval = 1s;
        .window = 10;
        .threshold = 8;
     }
}
acl purgers {
    "127.0.0.1";
    "78.56.0.0"/16;
}
sub vcl_recv {
    if (req.http.host == "images.ecency.com" || req.http.host == "www.images.ecency.com") {
        set req.backend_hint = default;
    }
    if (req.method == "PURGE"){
       if (!client.ip ~ purgers) {
           return (synth(405, "Purging not allowed for " + client.ip));
       }
       return (purge);
    }

    # Cache invalidation: ban the normal URL from cache, then pass through
    # to backend so it can delete local files and purge Cloudflare.
    if (req.url ~ "[?&]invalidate=") {
        ban("req.url ~ ^" + regsub(req.url, "\?.*$", "") + "($|\?)");
        return (pass);
    }
    # Cache bypass: pass through to backend without serving from cache.
    if (req.url ~ "[?&]ignorecache=") {
        return (pass);
    }

    # Only cache avatars, covers, and blur placeholders — they are small (~2KB)
    # and frequently requested. Proxy images and uploads are large (100KB-1.6MB)
    # and long-tail, so they churn through the cache too fast to be useful.
    if (req.url !~ "^/u/" && req.url !~ "[?&]blur=") {
        return (pass);
    }

    # Remove has_js, Google Analytics (_ga, _ga_*, _gid, _gat), and Cloudflare __* cookies.
    set req.http.Cookie = regsuball(req.http.Cookie, "(^|;\s*)(_[_a-zA-Z0-9]+|has_js)=[^;]*", "");
    # Remove a ";" prefix, if present.
    set req.http.Cookie = regsub(req.http.Cookie, "^;\s*", "");
    # If Cookie header is empty after cleanup, remove it so builtin VCL
    # doesn't force pass on every request.
    if (req.http.Cookie ~ "^\s*$") {
        unset req.http.Cookie;
    }
}

sub vcl_backend_response {
    # Default: generous grace and keep for stale-serving during backend issues.
    set beresp.grace = 24h;
    set beresp.keep = 7d;

    # Respect no-cache from backend (avatar/cover invalidation, healthcheck).
    # These must not be cached by Varnish.
    if (beresp.http.Cache-Control ~ "no-cache") {
        set beresp.uncacheable = true;
        set beresp.ttl = 0s;
        return (deliver);
    }

    # Error responses: serve stale from cache if possible, never cache errors.
    if (beresp.status == 404 || beresp.status == 400 || beresp.status >= 500) {
        if (bereq.is_bgfetch)
        {
            return (abandon);
        }
        set beresp.ttl = 60s;
        set beresp.uncacheable = true;
    }
    # Avatars and covers: shorter TTL so updates propagate, but keep grace
    # so stale content is served if backend is slow/down.
    # Backend sends max-age=3600 for success, max-age=120 for fallback.
    else if (bereq.url ~ "avatar" || bereq.url ~ "cover") {
        if (beresp.http.Cache-Control ~ "max-age=120") {
            # Fallback avatar/cover — cache 2 minutes, short grace
            set beresp.ttl = 120s;
            set beresp.grace = 120s;
            set beresp.http.Cache-Control = "public,max-age=120";
        } else {
            # Successful avatar/cover — cache 1 hour, moderate grace
            set beresp.ttl = 3600s;
            set beresp.grace = 1h;
            set beresp.http.Cache-Control = "public,max-age=3600";
        }
    }
    # Everything else (blur placeholders, etc): cache for 24h.
    # Note: proxy/upload requests are passed in vcl_recv so this TTL is
    # only used for non-avatar/cover URLs that Varnish actually caches.
    else {
        set beresp.ttl = 24h;
    }
}
sub vcl_synth {
    if (resp.status == 503 && req.restarts < 2) {
        return (restart);
    }
}
sub vcl_deliver {
    unset resp.http.X-Varnish;
    unset resp.http.Via;
}
