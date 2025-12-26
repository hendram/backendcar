import mysql from "mysql2/promise";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// ---------------------
// Create TiDB connection pool
// ---------------------
const pool = mysql.createPool({
  host: process.env.TIDB_HOST,       
  user: process.env.TIDB_USER,       
  password: process.env.TIDB_PASS,   
  database: process.env.TIDB_DB_NAME || "test", // use env or default to 'test'
  port: parseInt(process.env.TIDB_PORT) || 4000,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
    ssl: {
    ca: fs.readFileSync("./ca.pem")  
  }
});

// ---------------------
// Initialize tables
// ---------------------
export async function initTables() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS cars (
        id INT AUTO_INCREMENT PRIMARY KEY,
        car_id VARCHAR(50) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS car_places (
        id INT AUTO_INCREMENT PRIMARY KEY,
        car_id VARCHAR(50) NOT NULL,
        place_name VARCHAR(255) NOT NULL,
        place_order INT NOT NULL,
        FOREIGN KEY (car_id) REFERENCES cars(car_id) ON DELETE CASCADE
      );
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS car_videos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        car_id VARCHAR(50) NOT NULL,
        filename VARCHAR(255) NOT NULL,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (car_id) REFERENCES cars(car_id) ON DELETE CASCADE
      );
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS car_latest_positions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        car_id VARCHAR(50) NOT NULL,
        trip_doc VARCHAR(100) NOT NULL,
        lat DOUBLE NOT NULL,
        lng DOUBLE NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (car_id) REFERENCES cars(car_id) ON DELETE CASCADE
      );
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS car_trip_legs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        car_id VARCHAR(50) NOT NULL,
        trip_collection VARCHAR(100) NOT NULL,
        leg_index INT NOT NULL,
        origin VARCHAR(255) NOT NULL,
        destination VARCHAR(255) NOT NULL,
        distance_m INT NOT NULL,
        duration_s INT NOT NULL,
        eta TIMESTAMP NOT NULL,
        FOREIGN KEY (car_id) REFERENCES cars(car_id) ON DELETE CASCADE
      );
    `);

    console.log("✅ TiDB tables initialized");
  } catch (err) {
    console.error("🔥 Failed to initialize TiDB tables:", err);
  } finally {
    conn.release();
  }
}

// ---------------------
// Query helper
// ---------------------
export async function query(sql, params) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// ---------------------
// Export connection pool
// ---------------------
export default pool;
