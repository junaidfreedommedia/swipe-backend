# Use the official Node.js 14 image as the base image
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy the package.json and package-lock.json files to the working directory
COPY web/package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code to the working directory
COPY web/ ./

# Expose the port the app runs on (if known, e.g., 3000)
EXPOSE 8080

# Set the command to run the application
CMD ["npm", "run", "prod"]
