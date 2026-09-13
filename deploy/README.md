# Backend Docker y Cloud Run

La imagen sirve únicamente la API, OAuth y `/healthz`; no incluye la interfaz de React.

## Construcción local

Desde la carpeta backend:

```sh
docker build -f Dockerfile -t journal-backend:local .
```

La imagen usa Node 24, ejecuta TypeScript verificado, escucha en `0.0.0.0:$PORT` y corre como usuario `node`. El contexto usa una lista de archivos permitidos: no se suben `.env`, SQLite, snapshots, claves ni sesiones de gcloud. Cloud Run proporciona `PORT` automáticamente.

Para una prueba del arranque sin conectar a Google Cloud, usar un SQLite vacío efímero:

```sh
docker run --rm -p 127.0.0.1:8080:8080 \
  -e DATA_BACKEND=sqlite -e APP_ORIGIN=http://localhost:8080 \
  journal-backend:local
curl http://localhost:8080/healthz
```

Esto solo valida el contenedor; no valida Firestore ni OAuth real. En Cloud Run el servidor rechaza SQLite porque su disco es temporal. `/healthz` indica que el servidor terminó de arrancar; no efectúa consultas periódicas a Firestore.

## Antes de desplegar

1. Elegir la región cercana a la base Firestore. Consultar la ubicación con `gcloud firestore databases describe --database=YOUR_DATABASE_ID --project=YOUR_PROJECT_ID`.
2. Usar una cuenta de servicio propia del backend. Necesita `roles/datastore.user` para Firestore y `roles/storage.objectUser` sobre el bucket `YOUR_BUCKET_NAME`. Evitar claves JSON; Cloud Run proporciona la identidad automáticamente.
3. Crear en Secret Manager `journal-google-client-secret` y `journal-calendar-token-key`, con los valores actuales. Dar `roles/secretmanager.secretAccessor` a la cuenta del backend sobre esos secretos. Mantener la clave de cifrado actual para poder leer los tokens importados; no generar otra.
4. Copiar `deploy/cloudrun.env.example.yaml` a `deploy/cloudrun.env.local.yaml` y completar APP_ORIGIN y GOOGLE_CLIENT_ID. Este archivo no entra en Git ni en la imagen. Usar un namespace de pruebas separado de producción. Para producción, migrar/verificar otro namespace antes de arrancar y definir explícitamente si se habilita Calendar.
5. Asegurar que el frontend envía `/api/` y `/auth/` al backend a través del mismo dominio público, conservando Host, cookies y Origin. El backend actual valida Host contra APP_ORIGIN. Un balanceador/gateway debe preservar ese host; una llamada directa desde otro dominio no funciona con las cookies actuales. No es suficiente cambiar una URL del frontend o habilitar CORS. Registrar `${APP_ORIGIN}/auth/callback` en el cliente OAuth. La ruta `/` de esta imagen devuelve 404 deliberadamente porque solo sirve API.

## Despliegue con tu gcloud (comandos preparados, no ejecutados)

Google Cloud puede construir Dockerfile con cloudbuild.yaml en Cloud Build; no necesitas subir la imagen manualmente. Requiere Cloud Run, Cloud Build, Artifact Registry y Secret Manager habilitados y los permisos correspondientes del usuario que despliega.

```sh
JOURNAL_REGION=REGION_ELEGIDA
JOURNAL_SERVICE_ACCOUNT=CUENTA_BACKEND@YOUR_PROJECT_ID.iam.gserviceaccount.com

# Desde la carpeta backend, con un repositorio Artifact Registry existente:
JOURNAL_IMAGE="$JOURNAL_REGION-docker.pkg.dev/YOUR_PROJECT_ID/REPOSITORIO/journal-backend:VERSION"
gcloud builds submit . \
  --project=YOUR_PROJECT_ID \
  --config=cloudbuild.yaml \
  --substitutions="_IMAGE=$JOURNAL_IMAGE"

gcloud run deploy journal-backend \
  --project=YOUR_PROJECT_ID \
  --region="$JOURNAL_REGION" \
  --image="$JOURNAL_IMAGE" \
  --service-account="$JOURNAL_SERVICE_ACCOUNT" \
  --port=8080 \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=1 \
  --concurrency=8 \
  --timeout=300 \
  --env-vars-file=deploy/cloudrun.env.local.yaml \
  --set-secrets=GOOGLE_CLIENT_SECRET=journal-google-client-secret:1,CALENDAR_TOKEN_KEY=journal-calendar-token-key:1 \
  --no-allow-unauthenticated
```

Sustituir las versiones `:1` si tus secretos tienen otra versión. El servicio se crea privado para comprobarlo primero con `gcloud run services proxy journal-backend --region="$JOURNAL_REGION" --project=YOUR_PROJECT_ID --port=8080`. Consultar `/healthz` desde ese proxy. El acceso público/proxy del frontend se configura después según el dominio y hosting elegidos; un navegador no puede entrar directamente en un servicio Cloud Run privado usando solo el login de Journal.

No se han creado cuentas de servicio, secretos, balanceadores ni servicios Cloud Run desde este cambio. La configuración propuesta de una instancia es para empezar con este journal personal; las transacciones leen parte del historial y aún necesitan optimización antes de escalar. Los roles de Cloud Build y de quien despliega son distintos de los de la cuenta que ejecuta la API.

Referencias: [contrato de contenedores](https://docs.cloud.google.com/run/docs/container-contract), [despliegue desde código](https://docs.cloud.google.com/run/docs/deploying-source-code), [Secret Manager en Cloud Run](https://docs.cloud.google.com/run/docs/configuring/services/secrets).
