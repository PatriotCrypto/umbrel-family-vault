FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
# Umbrel creates the data folder as root: fix ownership, then run the app unprivileged.
CMD ["sh", "-c", "mkdir -p /data && chown node:node /data && exec su-exec node node server.js"]
