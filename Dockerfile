FROM denoland/deno:2.9.7 AS build

ENV DENO_DIR=/deno-dir

WORKDIR /app

COPY deno.json deno.lock ./
RUN deno install --frozen

COPY src ./src
COPY scripts/migrate.ts ./scripts/migrate.ts
COPY drizzle ./drizzle

RUN deno check src scripts


FROM denoland/deno:2.9.7 AS runtime

ENV DENO_DIR=/deno-dir \
    DENO_NO_UPDATE_CHECK=1 \
    TRANSCRIPT_DIR=/home/container/data/transcripts \
    HEALTH_HOST=127.0.0.1

RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends iproute2 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -d /home/container -s /bin/bash container

COPY --from=build /deno-dir /deno-dir
COPY --from=build /app /app
COPY pterodactyl/entrypoint.sh /entrypoint.sh
COPY pterodactyl/start.sh /app/start.sh

RUN chmod -R a+rX /deno-dir /app && chmod 755 /entrypoint.sh /home/container

WORKDIR /home/container

USER container

ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
