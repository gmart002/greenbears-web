# Green Bears web — imagen liviana y autocontenida.
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Instala solo dependencias de producción (better-sqlite3 trae binario precompilado).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# Datos persistentes (SQLite + imágenes subidas) fuera de la imagen.
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000

# Ejecuta como usuario sin privilegios (ya existe en la imagen node).
RUN mkdir -p /data && chown -R node:node /data
USER node

CMD ["node", "src/server.js"]
