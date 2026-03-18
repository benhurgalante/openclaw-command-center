#!/bin/bash
# Script de inicialização do ServCom no IRIS
# Executar após o container estar rodando

echo "=== ServCom Docker Init ==="
echo "1. Configurando namespaces..."

# Executar script de configuração
iris session IRIS < /opt/iris.script

echo "2. Importando classes RTD..."
iris session IRIS -U RTD << 'EOF'
Do $System.OBJ.Load("/opt/import/classes-namespace-RTD-export.xml","ck")
Write "RTD classes imported!",!
Halt
EOF

echo "3. Importando classes RPJ..."
iris session IRIS -U RPJ << 'EOF'
Do $System.OBJ.Load("/opt/import/rpj-classes.xml","ck")
Write "RPJ classes imported!",!
Halt
EOF

echo "=== Init completo ==="
