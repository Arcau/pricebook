FROM node:24-alpine
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    PORT=3020 \
    DATA_DIR=/app/data
WORKDIR /app
COPY server.js ./
COPY public ./public
# npm isn't used (no dependencies) and carries its own CVEs, so leave it out of the image
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3020
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3020/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
