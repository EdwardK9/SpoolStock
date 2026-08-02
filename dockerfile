FROM python:3.11-slim

# Set the working directory
WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Create the data directory for the SQLite database
RUN mkdir -p /app/data

# Expose the Flask port
EXPOSE 5000

# Run the application
# We use 0.0.0.0 so it's accessible outside the container
CMD ["python", "app.py"]