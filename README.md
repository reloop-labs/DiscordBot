# Loop

Loop is the community bot for the [Reloop](https://reloop.sh) Discord server. It handles moderation,
moderation cases and staff notes, automod and raid signals, tickets with transcripts,
self-assignable role menus, join and leave handling, reports, suggestions, and staff logging. It is
a community operations tool, not part of the Reloop product.

Loop does not run a verification flow. A member joins, receives the configured member role, gets an
optional welcome message, and can pick optional self roles.

## Stack

- Deno 2.9, TypeScript
- Discordeno 21 (gateway, REST, interactions)
- PostgreSQL 18 with Drizzle ORM and postgres.js
- Redis 8 (cooldowns, rolling windows, locks; never authoritative)
- Zod 4 for configuration and input validation
- Docker Compose for production, GitHub Actions for CI and deployment, images on GHCR

## Layout

```
src/
  main.ts               composition root
  app/                  lifecycle, scheduler, service container
  config/               environment validation
  logging/              structured JSON logger with secret redaction
  database/             drizzle client, schema, sequences
  redis/                key-value store with fail-open semantics
  health/               /healthz and /readyz
  permissions/          Loop permission keys, role grants, Discord hierarchy checks
  discord/
    adapters/           DiscordApi port and the Discordeno implementation
    interactions/       interaction context, router, custom id codec
    commands/           slash and context commands per domain
    events/             gateway event handlers
    logging/            staff log channel posting
  domains/              moderation, tickets, roles, members, automod, reports, suggestions, audit, guild-config
drizzle/                migrations (generated, reviewed, committed)
scripts/                migrate, register-commands, deploy, backup, restore-test
tests/                  unit and database-backed tests
```

Business logic lives in domain services. Discord is an interface layer: commands and events
translate interactions into service calls, and services reach Discord only through the `DiscordApi`
port so they can be tested against an in-memory fake.

## Requirements

- Deno 2.9 or newer
- Docker with Compose (for local Postgres and Redis, and for production)
- A Discord application with a bot user

## Discord application setup

1. Create an application at https://discord.com/developers/applications and add a bot.
2. Privileged gateway intents: enable **Server Members** and **Message Content**. Presence is not
   used.
3. Invite the bot with the `bot` and `applications.commands` scopes and these permissions: View
   Channels, Manage Channels, Manage Roles, Kick Members, Ban Members, Moderate Members, Manage
   Nicknames, Manage Messages, Read Message History, Send Messages, Embed Links, Attach Files,
   Create Private Threads. Administrator is not required and not recommended.
4. Place Loop's role above every role it should manage or moderate. Loop never bypasses Discord's
   role hierarchy.

## Local development

```bash
cp .env.example .env
docker compose -f compose.dev.yml up -d
deno task db:migrate
deno task discord:commands
deno task dev
```

`deno task discord:commands` registers commands to `DISCORD_DEV_GUILD_ID` for instant iteration.
Pass `--global` to register globally for production (global commands take up to an hour to
propagate).

Other tasks:

```bash
deno fmt              # format
deno lint             # lint
deno task check       # type-check src, scripts and tests
deno task test        # run tests (database tests skip if Postgres is unreachable)
deno task db:generate # create a migration after editing src/database/schema
```

## Configuration

Infrastructure secrets come from the environment and are validated at startup:

| Variable                 | Purpose                                               |
| ------------------------ | ----------------------------------------------------- |
| `DISCORD_TOKEN`          | Bot token                                             |
| `DISCORD_APPLICATION_ID` | Application id                                        |
| `DISCORD_DEV_GUILD_ID`   | Guild for development command registration (optional) |
| `DATABASE_URL`           | PostgreSQL connection string                          |
| `REDIS_URL`              | Redis connection string                               |
| `PORT`                   | Health server port (default 8080)                     |
| `HEALTH_HOST`            | Health server bind address (default 127.0.0.1)        |
| `LOG_LEVEL`              | debug, info, warn, error                              |
| `ENVIRONMENT`            | development, production, test                         |
| `TRANSCRIPT_DIR`         | Directory for ticket transcript files                 |

Everything guild-specific (member role, log channels, ticket categories, role menus, automod rules,
staff permissions) is stored in PostgreSQL and managed with slash commands. Nothing guild-specific
is hardcoded.

## Runtime permissions

Loop runs with `--allow-net --allow-env --allow-read=./data --allow-write=./data`. Network is needed
for Discord, Postgres, Redis and the health server; env for configuration; the data directory for
transcripts. Nothing else is granted.

## Commands

Staff commands are hidden from members by default through Discord's default member permissions, but
the real gate is Loop's own permission system: roles are mapped to keys such as `moderation.ban` or
`tickets.manage` with `/permissions grant`. The server owner and Discord administrators always hold
every key.

| Area        | Commands                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup       | `/config view                                                                                                                                 |
| Moderation  | `/warn`, `/timeout`, `/untimeout`, `/kick`, `/ban`, `/unban`, `/purge`, `/slowmode`, `/lock`, `/unlock`, `/nickname`, `/history`, `/case view |
| Roles       | `/rolemenu create                                                                                                                             |
| Tickets     | `/ticket close                                                                                                                                |
| Automod     | `/automod list                                                                                                                                |
| Reports     | `/report user                                                                                                                                 |
| Suggestions | `/suggest`, `/suggestion status                                                                                                               |

Every moderation action creates a numbered case. Voiding a case keeps it in the record. DMs to
affected users are best effort and never block the action.

## Health

`GET /healthz` returns 200 while the process is alive. `GET /readyz` returns 200 only when the
gateway is connected and PostgreSQL answers; Redis being down reports `degraded` but stays ready
because Loop keeps working without it.

## Shutdown

On `SIGTERM` or `SIGINT` Loop marks itself not ready, stops scheduled jobs, disconnects from
Discord, closes Redis and PostgreSQL, stops the health server, and exits.

## Production

Loop is published as `ghcr.io/reloop-labs/loop:<git sha>` and runs on Pterodactyl from the egg in
`pterodactyl/egg-loop.json`, alongside PostgreSQL and Redis servers created from
`pterodactyl/egg-postgres-18.json` and `pterodactyl/egg-redis-8.json` on loopback allocations. The
image ships the code and Deno cache; the server volume holds only transcript files. Startup applies
migrations and then starts the bot; the panel reports the server running once the gateway is ready.

Pushing to `main` builds and pushes the image, moves the `production` tag, restarts the panel server
through the client API, and waits for it to report running. Rollback is the same workflow run
manually with an older sha. Backups are `pg_dump` archives, compressed and encrypted with `age`,
taken from the node host on a schedule and copied off the machine; see `scripts/backup.sh` and
`scripts/restore-test.sh`.

## Data

Loop stores what it needs to operate the community: guild configuration, moderation cases and notes,
tickets and their transcripts, role menus, automod rules, reports, suggestions and votes, and a
configuration audit trail. It does not archive messages, track presence or voice activity, or score
members. Message content appears only in transcripts of tickets, in report excerpts submitted by a
reporter, and in staff log embeds.

## License

Apache-2.0
