# Use official Node.js LTS lightweight Alpine image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Copy package descriptors
COPY package*.json ./

# Install production dependencies only (BareWeb has 0 runtime dependencies)
RUN npm ci --omit=dev

# Copy source code and example server with appropriate ownership
COPY --chown=node:node src/ ./src/
COPY --chown=node:node examples/ ./examples/

# Switch to non-root node user
USER node

# Expose server port
EXPOSE 3000

# Add container health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/ || exit 1

# Run BareWeb server
CMD ["node", "examples/basic-server.js"]
