# Persistencia del control de detractores

Actualmente las novedades se guardan en `data/detractor-notes.json`. Esto permite usar el módulo inmediatamente y conserva la información después de reiniciar Node, pero para producción se recomienda PostgreSQL.

## Esquema recomendado

```sql
create table detractor_notes (
  id uuid primary key default gen_random_uuid(),
  phone varchar(30) not null,
  note_text text not null,
  author varchar(100) not null,
  status varchar(30) not null check (status in ('Pendiente','En gestión','Contactado','Cerrado')),
  created_at timestamptz not null default now()
);

create index detractor_notes_phone_created_idx
  on detractor_notes (phone, created_at desc);
```

## Conexión

1. Crear una base PostgreSQL administrada, por ejemplo en Supabase, Neon, AWS RDS o un servidor propio.
2. Agregar `DATABASE_URL=postgresql://usuario:clave@servidor:5432/base` al archivo `.env`.
3. Instalar el controlador con `npm install pg`.
4. Sustituir `readDetractorNotes()` y `saveDetractorNotes()` de `server.js` por consultas parametrizadas `SELECT` e `INSERT`.
5. Mantener la misma API `/api/detractor-notes`; la interfaz no necesitará cambios.

No se debe publicar `DATABASE_URL` ni colocarla en archivos del navegador. La conexión debe permanecer exclusivamente en el servidor Node.
