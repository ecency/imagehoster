#
# Varnish VCL for i.ecency.com
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
    .host = "127.0.0.1";
    .port = "8800";
    .connect_timeout = 3s;
    .first_byte_timeout = 20s;
    .between_bytes_timeout = 10s;
    .max_connections = 900;
    .probe = {
        .url = "/";
        .timeout = 2s;
        .interval = 5s;
        .window = 5;
        .threshold = 3;
     }
}

# Dedicated backend lane for uploads (POST). Same origin process as `default`,
# but Varnish tracks max_connections per backend OBJECT, so uploads get an
# isolated connection pool and can never be starved by proxy-fetch saturation
# (the /p/* long tail exhausts `default` and returns 503 "backend busy").
# Longer first_byte_timeout: an upload is body-read + sharp + S3 PUT, which is
# legitimately slower than a proxy fetch.
backend uploads {
    .host = "127.0.0.1";
    .port = "8800";
    .connect_timeout = 3s;
    .first_byte_timeout = 120s;
    .between_bytes_timeout = 30s;
    .max_connections = 40;
}
acl purgers {
    "127.0.0.1";
    "78.56.0.0"/16;
}
# Who may BAN a user's avatar or cover: the imagehoster container, which reaches
# Varnish from a Docker bridge network. Deliberately not 127.0.0.1, because
# public traffic arrives from nginx on loopback.
acl banners {
    "172.16.0.0"/12;
}
sub vcl_recv {
    if (
        req.http.host == "i.ecency.com" ||
        req.http.host == "www.i.ecency.com" ||
        req.http.host == "images.ecency.com" ||
        req.http.host == "www.images.ecency.com"
    ) {
        set req.backend_hint = default;
    }

    # Uploads (imagehoster exposes POST only for upload routes: /hs/:token,
    # /:user/:sig, /webp/hs/:token) go to the isolated `uploads` backend so a
    # saturated proxy pool cannot 503 them. Always pass — never cacheable.
    if (req.method == "POST") {
        set req.backend_hint = uploads;
        return (pass);
    }
    # Profile image change: imagehoster asks to drop every cached size, route
    # (/u and /webp/u) and hostname of one user's avatar or cover. Varnish
    # builds the ban itself from two validated headers, so the caller cannot
    # ban anything else. Dots in the name are escaped so a.b cannot match axb.
    # Case-insensitive because the handlers lowercase the name, so /u/Alice
    # serves alice. The ban tests obj.http.x-url (set below) rather than
    # req.url so the ban lurker can retire it instead of it piling up.
    if (req.method == "BAN") {
        if (!client.ip ~ banners) {
            return (synth(405, "Banning not allowed for " + client.ip));
        }
        if (req.http.X-Ban-User !~ "^[a-z0-9][a-z0-9.-]{1,15}$" ||
            req.http.X-Ban-Kind !~ "^(avatar|cover)$") {
            return (synth(400, "Bad ban request"));
        }
        ban("obj.http.x-url ~ (?i)^(/webp)?/u/" + regsuball(req.http.X-Ban-User, "\.", "\\.") + "/" + req.http.X-Ban-Kind + "(/|\?|$)");
        return (synth(200, "Banned"));
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
    # Stored with the object for the lurker-friendly BAN above; removed in vcl_deliver.
    set beresp.http.x-url = bereq.url;

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
    unset resp.http.x-url;
    # Cloudflare's default cache key includes these request headers (excluding
    # them needs an Enterprise plan), and the purge on a profile change
    # (profile-change.ts) lists bare URLs. So an avatar or cover requested with
    # any of them may only be cached briefly. Browsers loading an <img> send
    # none of them. Changes only the header sent, not the stored object.
    if (req.url ~ "^/u/" && resp.http.Cache-Control ~ "max-age=3600" && (
        req.http.Origin || req.http.X-HTTP-Method || req.http.X-HTTP-Method-Override ||
        req.http.X-Method-Override || req.http.X-Forwarded-Host || req.http.X-Host ||
        req.http.X-Forwarded-Scheme || req.http.X-Original-URL || req.http.X-Rewrite-URL ||
        req.http.Forwarded)) {
        set resp.http.Cache-Control = "public,max-age=120";
    }
    unset resp.http.X-Varnish;
    unset resp.http.Via;
}
