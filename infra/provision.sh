#!/usr/bin/env bash
# Recreates the Azure resources the demo needs (Entra-only auth, no keys).
# Usage: SUBSCRIPTION=<sub id or name> [PREFIX=trust-harness] [RG=rg-trust-harness] ./infra/provision.sh
# Afterwards point the app at the new endpoints:
#   export A1_AOAI_ENDPOINT=https://<foundry>.openai.azure.com/openai/v1/
#   export A1_CS_ENDPOINT=https://<foundry>.cognitiveservices.azure.com
#   export A1_TA_ENDPOINT=https://<cs-eus>.cognitiveservices.azure.com
set -euo pipefail
: "${SUBSCRIPTION:?set SUBSCRIPTION}"
PREFIX="${PREFIX:-trust-harness}"
RG="${RG:-rg-$PREFIX}"
FOUNDRY="foundry-$PREFIX"
CS_EUS="cs-$PREFIX-eus"

az account set -s "$SUBSCRIPTION"
OID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || az account get-access-token --query accessToken -o tsv | cut -d. -f2 | tr '_-' '/+' | python3 -c "import sys,base64,json;s=sys.stdin.read().strip();s+='='*(-len(s)%4);print(json.loads(base64.b64decode(s))['oid'])")

az group create -n "$RG" -l swedencentral -o none

# Foundry (AI Services) in Sweden Central: model + Prompt Shields
az cognitiveservices account create -n "$FOUNDRY" -g "$RG" -l swedencentral --kind AIServices --sku S0 \
  --custom-domain "$FOUNDRY" --allow-project-management --yes -o none
az cognitiveservices account project create -g "$RG" -n "$FOUNDRY" --project-name trust -l swedencentral -o none
az cognitiveservices account deployment create -g "$RG" -n "$FOUNDRY" --deployment-name gpt-4.1-mini \
  --model-name gpt-4.1-mini --model-version 2025-04-14 --model-format OpenAI --sku-name GlobalStandard --sku-capacity 100 -o none

# Content Safety in East US: Task Adherence (preview, not available in Sweden Central)
az cognitiveservices account create -n "$CS_EUS" -g "$RG" -l eastus --kind ContentSafety --sku S0 --custom-domain "$CS_EUS" --yes -o none

for ACC in "$FOUNDRY" "$CS_EUS"; do
  SCOPE=$(az cognitiveservices account show -g "$RG" -n "$ACC" --query id -o tsv)
  for ROLE in "Cognitive Services User" "Cognitive Services OpenAI User"; do
    az role assignment create --assignee-object-id "$OID" --assignee-principal-type User --role "$ROLE" --scope "$SCOPE" -o none || true
  done
done

echo "Done. Endpoints:"
echo "  A1_AOAI_ENDPOINT=https://$FOUNDRY.openai.azure.com/openai/v1/"
echo "  A1_CS_ENDPOINT=https://$FOUNDRY.cognitiveservices.azure.com"
echo "  A1_TA_ENDPOINT=https://$CS_EUS.cognitiveservices.azure.com"
