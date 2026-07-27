# promo-bff в контейнере — для переезда на прод-машину рядом с витриной.
#
# Почему вообще контейнер: на проде Node на хосте НЕТ, всё живёт в Docker под
# Traefik. Ставить туда nvm ради одного сервиса — плодить сущность, которой на
# машине нет; проще прийти в её конвенции.
#
# Почему НЕ компилируем в JS: сервис и на eremin.site запускается из исходников
# через tsx (`node --import tsx src/server.ts`), поведение проверено годом
# работы. Компиляция — отдельное изменение с отдельными рисками (пути,
# резолвинг, source maps); мешать его с переездом не стоит. Поэтому tsx
# остаётся, а образ несёт devDependencies — цена в ~100 МБ, зато переезд
# ничего не меняет в рантайме.
FROM node:22-alpine AS deps

WORKDIR /app

# Приватный @zebrooo/service-ticket живёт в GitHub Packages, .npmrc в репозитории
# подставляет ${NODE_AUTH_TOKEN}. Токен передаётся СЕКРЕТОМ сборки, а не ARG:
# ARG остаётся в истории слоёв образа, секрет — нет.
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=node_auth_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token)" \
    npm ci --no-audit --no-fund

# ── Рантайм ────────────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# dumb-init: PID 1 в контейнере не пересылает сигналы и не жнёт зомби. Без
# него `docker stop` ждёт 10 с и убивает Fastify по SIGKILL — это оборванные
# запросы на каждом релизе.
RUN apk add --no-cache dumb-init

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# Не root: сервис ходит в S3 и в две базы, лишние права ему ни к чему.
USER node

ENV NODE_ENV=production
EXPOSE 3191

# tsx как в systemd-юните на eremin.site — один в один, чтобы переезд не менял
# способ запуска. Холодный старт ~50 с: это транспиляция на лету, а не зависон,
# healthcheck в compose учитывает это через start_period.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--import", "tsx", "src/server.ts"]
