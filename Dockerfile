# Use official Node.js LTS lightweight Alpine image
FROM node:20-alpine AS runner

# Set working directory
WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Copy package descriptors
COPY package*.json ./

# Install production dependencies only (BareWeb has 0 runtime dependencies)
RUN npm ci --omit=dev

# Copy source code and example server
COPY src/ ./src/
COPY examples/ ./examples/

# Expose server port
EXPOSE 3000

# Run BareWeb server
CMD ["node", "examples/basic-server.js"]
