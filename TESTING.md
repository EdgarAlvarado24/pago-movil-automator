# Pruebas pendientes

## Admin: whitelist

```bash
# Obtén el telegram_id del usuario (él lo ve al hacer /start)
# Ejemplo: 123456789

# Aprobar usuario
/whitelist add 123456789
# → "✅ Usuario 123456789 (Nombre) aprobado."

# Quitar aprobación
/whitelist remove 123456789
# → "✅ Usuario 123456789 desaprobado."

# Si el usuario no existe en DB:
# → "⚠️ Usuario 123456789 no encontrado. Primero debe enviar /start al bot."
```

## Admin: listusers

```
/listusers
# → 👥 Usuarios (2)
# ✅ 123456789 — Juan
# ⏳ 987654321 — María
```

## Admin: removeuser

```
/removeuser 123456789
# → "✅ Usuario 123456789 desactivado."
```

## Admin: broadcast

```
/broadcast El bot se actualizará esta noche.
```

## Usuario: setup

```
/setup
# → Paso 1: pegar SA JSON
# → Paso 2: pegar Spreadsheet ID
# → "✅ Configuración completada!"
```

## Usuario: status

```
/status
# → "✅ Conexión exitosa" o mensaje de error
```

## Usuario: mystats

```
/mystats
# → Estadísticas de pagos registrados
```
