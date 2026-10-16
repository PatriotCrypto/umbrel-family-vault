FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
