# Herramientas de análisis de ralentí -- reorganizadas

Estos 2 archivos reemplazan los 6 scripts sueltos que se fueron armando durante
la sesión de depuración de las reglas de ralentí (furgones, N400):

| Script viejo (ya borrado) | Reemplazado por |
|---|---|
| `analisis_ralenti_furgones.py` | `analisis_ralenti.py resumen` |
| `analisis_rpm_ralenti_furgones.py` | `analisis_ralenti.py rango-rpm` |
| `diagnostico_regla_furgon.py` | `analisis_ralenti.py diagnosticar-regla` |
| `diagnostico_regla.py` | `analisis_ralenti.py diagnosticar-regla` |
| `analisis_historico_1927.py` | `analisis_ralenti.py historico-vehiculo` |
| `ubicacion_eventos_1927.py` | `analisis_ralenti.py ubicaciones` |
| `verificar_zona_sede.py` | `analisis_ralenti.py verificar-zona` |

## Instalación

1. Copia `geotab_comun.py` y `analisis_ralenti.py` a tu carpeta `Proyecto_Geotab`
   (junto a `app.py`, `telegram_alertas.py`, `.streamlit/`).
2. **Borra los 6 scripts sueltos** de la tabla de arriba -- ya no hacen falta.
3. Las credenciales se siguen leyendo igual, desde `.streamlit/secrets.toml`.

## Uso

```bash
# Resumen de ralenti por tipologia (reemplaza analisis_ralenti_furgones.py)
python analisis_ralenti.py resumen --tipologia furgon --dias 7

# Comparar diagnosticos de RPM (reemplaza analisis_rpm_ralenti_furgones.py)
python analisis_ralenti.py rango-rpm --tipologia furgon --dias 7

# Diagnosticar cualquier regla por nombre (reemplaza diagnostico_regla.py)
python analisis_ralenti.py diagnosticar-regla --regla "V_RALENTÍ N400 800 RPM" --dias 30

# Patron historico de una regla en un vehiculo especifico
python analisis_ralenti.py historico-vehiculo --regla "V_RALENTÍ N400 800 RPM" --vehiculo 1927-QQU073 --dias 60

# Ubicacion GPS de cada evento de un vehiculo
python analisis_ralenti.py ubicaciones --regla "V_RALENTÍ N400 800 RPM" --vehiculo 1927-QQU073 --dias 60

# Verificar si una coordenada cae dentro de una zona
python analisis_ralenti.py verificar-zona --lat 4.63417816 --lon -74.1113434 --zona b28CB
```

Para ver todos los parámetros de un subcomando: `python analisis_ralenti.py <subcomando> -h`

## Qué cambió respecto a los scripts sueltos

- **Cero código duplicado**: la conexión a Geotab, la resolución de jerarquía de
  grupos, y las utilidades geométricas viven una sola vez en `geotab_comun.py`.
- **Un solo archivo ejecutable** (`analisis_ralenti.py`) con subcomandos, en vez
  de 6 archivos distintos -- mismo patrón que ya usa `geotab_reglas_v3.py`.
- **`diagnosticar-regla` y `historico-vehiculo`/`ubicaciones` ya no están atados
  a un vehículo o tipología fija** (antes tenían "furgon" o "1927-QQU073"
  escritos directo en el código) -- ahora todo se pasa por parámetro, así que
  sirven para validar cualquier regla o vehículo futuro sin tocar el código.
