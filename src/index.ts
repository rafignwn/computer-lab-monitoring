import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { Pool } from '@neondatabase/serverless';

// Load environment variables dari .env
dotenv.config();

const app = express();

// Middleware Utama
app.use(cors());
app.use(express.json());

// Handle Error Parsing JSON (Mencegah crash akibat malformed JSON dari client/curl)
app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof SyntaxError && 'status' in err && (err as any).status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      message: 'Format JSON yang dikirimkan tidak valid! Pastikan penulisan JSON sesuai.'
    });
  }
  next();
});

// Serve file statis UI Dashboard dari folder public
app.use(express.static(path.join(__dirname, '../public')));

// Inisialisasi Pool Koneksi ke Neon PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// --- Interface TypeScript ---
interface SensorPayload {
  mq2_raw: number;
  temperature: number;
  humidity: number;
  status_asap: string;
}

interface TelemetryRecord {
  id: number;
  mq2_raw: number;
  temperature: number;
  humidity: number;
  created_at: Date;
}

interface ConditionRecord {
  id: number;
  condition_status: string;
  created_at: Date;
}

// ---------------------------------------------------------
// Route 1: Halaman Utama UI Dashboard
// ---------------------------------------------------------
app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ---------------------------------------------------------
// Route 2: [POST] Simpan Data Sensor dari ESP32-S3
// ---------------------------------------------------------
app.post('/api/sensor-data', async (req: Request<{}, {}, SensorPayload>, res: Response): Promise<Response> => {
  const client = await pool.connect();
  try {
    const { mq2_raw, temperature, humidity, status_asap } = req.body;

    if (mq2_raw === undefined || temperature === undefined || humidity === undefined || !status_asap) {
      return res.status(400).json({
        success: false,
        message: 'Payload data tidak lengkap! Diperlukan: mq2_raw, temperature, humidity, status_asap'
      });
    }

    // Evaluasi Status Kondisi Ruangan
    let condition = 'Aman';
    const isSmoke = status_asap === 'ASAP';
    const isHighTemp = temperature >= 35.0;

    if (isSmoke && isHighTemp) {
      condition = 'Bahaya';
    } else if (isSmoke) {
      condition = 'Asap Terdeteksi';
    } else if (isHighTemp) {
      condition = 'Suhu Tinggi';
    }

    // Transaksi Atomic Database
    await client.query('BEGIN');

    const queryTelemetry = `
      INSERT INTO sensor_telemetry (mq2_raw, temperature, humidity)
      VALUES ($1, $2, $3)
      RETURNING id, mq2_raw, temperature, humidity, created_at;
    `;
    const telemetryRes = await client.query<TelemetryRecord>(queryTelemetry, [mq2_raw, temperature, humidity]);

    const queryCondition = `
      INSERT INTO room_conditions (condition_status)
      VALUES ($1)
      RETURNING id, condition_status, created_at;
    `;
    const conditionRes = await client.query<ConditionRecord>(queryCondition, [condition]);

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      message: 'Data berhasil disimpan!',
      telemetry: telemetryRes.rows[0],
      condition: conditionRes.rows[0]
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Database Error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Server error' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------
// Route 3: [GET] Ambil Data Telemetri Terbaru (Graph/Cards)
// ---------------------------------------------------------
app.get('/api/sensor-data', async (_req: Request, res: Response): Promise<Response> => {
  try {
    const query = `
      SELECT id, mq2_raw, temperature, humidity, created_at
      FROM sensor_telemetry
      ORDER BY created_at DESC
      LIMIT 50;
    `;
    const result = await pool.query<TelemetryRecord>(query);

    return res.status(200).json({
      success: true,
      total: result.rowCount,
      data: result.rows
    });
  } catch (error: any) {
    console.error('Database Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------
// Route 4: [GET] Ambil Data Kondisi Ruangan Terbaru
// ---------------------------------------------------------
app.get('/api/room-conditions', async (_req: Request, res: Response): Promise<Response> => {
  try {
    const query = `
      SELECT id, condition_status, created_at
      FROM room_conditions
      ORDER BY created_at DESC
      LIMIT 50;
    `;
    const result = await pool.query<ConditionRecord>(query);

    return res.status(200).json({
      success: true,
      total: result.rowCount,
      data: result.rows
    });
  } catch (error: any) {
    console.error('Database Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Jalankan Server Lokal
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`⚡️ [Server IoT]: Berjalan di http://localhost:${PORT}`);
  });
}

export default app;