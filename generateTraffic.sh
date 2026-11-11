#!/bin/bash

# Generates varied traffic against a JWT Pizza Service so that every Grafana
# metric (requests by method, active users, auth success/failure, pizzas sold,
# revenue, creation failures, latency) has meaningful, nonzero data.
#
# Prerequisite: ./generateData.sh <host> has been run (menu, franchise, d@/f@ users).

if [ -z "$1" ]; then
  echo "Usage: $0 <host>"
  echo "Example: $0 http://localhost:3000"
  exit 1
fi
host=$1

pids=()
cleanup() {
  echo "Terminating background processes..."
  kill "${pids[@]}" 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

# Run a curl command and print only the HTTP status code
execute_curl() {
  eval "curl -s -o /dev/null -w \"%{http_code}\" $1"
}

# login <email> <password> -> prints the auth token (empty on failure)
login() {
  curl -s -X PUT "$host/api/auth" -d "{\"email\":\"$1\", \"password\":\"$2\"}" -H 'Content-Type: application/json' | jq -r '.token // empty'
}

logout() {
  execute_curl "-X DELETE $host/api/auth -H \"Authorization: Bearer $1\""
}

# Menu items (menuId:description:price) matching generateData.sh
menu=("1:Veggie:0.0038" "2:Pepperoni:0.0042" "3:Margarita:0.0042" "4:Crusty:0.0028" "5:Charred Leopard:0.0099")

# pizza_items <count> -> JSON array body of <count> random pizzas
pizza_items() {
  local items="" entry id desc price
  for (( i=0; i < $1; i++ )); do
    entry=${menu[RANDOM % ${#menu[@]}]}
    IFS=: read -r id desc price <<< "$entry"
    [ -n "$items" ] && items+=", "
    items+="{ \"menuId\": $id, \"description\": \"$desc\", \"price\": $price }"
  done
  echo "$items"
}

# order <token> <count> -> prints HTTP status
order() {
  local items
  items=$(pizza_items "$2")
  execute_curl "-X POST $host/api/order -H 'Content-Type: application/json' -d '{\"franchiseId\": 1, \"storeId\":1, \"items\":[$items]}' -H \"Authorization: Bearer $1\""
}

# Anonymous user browsing the menu and franchises (GET traffic)
while true; do
  echo "Requesting menu..." "$(execute_curl "$host/api/order/menu")"
  sleep 2
  echo "Requesting franchises..." "$(execute_curl "$host/api/franchise")"
  sleep 3
done &
pids+=($!)

# Invalid logins (failed auth attempts), every 10 seconds
while true; do
  echo "Logging in with invalid credentials..." "$(execute_curl "-X PUT \"$host/api/auth\" -d '{\"email\":\"unknown@jwt.com\", \"password\":\"bad\"}' -H 'Content-Type: application/json'")"
  sleep 10
done &
pids+=($!)

# Franchisee logs in, views their franchises, logs out (active users + auth)
while true; do
  token=$(login "f@jwt.com" "franchisee")
  echo "Login franchisee..." "$( [ -z "$token" ] && echo false || echo true )"
  for _ in 1 2 3; do
    echo "Franchisee viewing profile..." "$(execute_curl "$host/api/user/me -H \"Authorization: Bearer $token\"")"
    sleep 15
  done
  echo "Logging out franchisee..." "$(logout "$token")"
  sleep 10
done &
pids+=($!)

# Several diners each buying a random number of pizzas (1-5) on their own cadence.
# Registration (POST) is attempted first; it harmlessly fails if the user exists.
for n in 1 2 3; do
  (
    email="diner$n@jwt.com"
    curl -s -o /dev/null -X POST "$host/api/auth" -d "{\"name\":\"diner $n\", \"email\":\"$email\", \"password\":\"diner\"}" -H 'Content-Type: application/json'
    while true; do
      token=$(login "$email" "diner")
      echo "Login $email..." "$( [ -z "$token" ] && echo false || echo true )"
      for _ in 1 2 3; do
        echo "$email bought pizzas..." "$(order "$token" $(( RANDOM % 5 + 1 )))"
        echo "$email checking orders..." "$(execute_curl "$host/api/order -H \"Authorization: Bearer $token\"")"
        sleep $(( RANDOM % 10 + 8 ))
      done
      echo "Logging out $email..." "$(logout "$token")"
      sleep $(( RANDOM % 10 + 5 ))
    done
  ) &
  pids+=($!)
done

# Original diner: one steady pizza every 30 seconds
while true; do
  token=$(login "d@jwt.com" "diner")
  echo "Login diner..." "$( [ -z "$token" ] && echo false || echo true )"
  echo "Bought a pizza..." "$(order "$token" 1)"
  sleep 20
  echo "Logging out diner..." "$(logout "$token")"
  sleep 10
done &
pids+=($!)

# Hungry diner: order >20 pizzas to trigger factory failures and high latency, every ~90 seconds
while true; do
  token=$(login "d@jwt.com" "diner")
  echo "Login hungry diner..." "$( [ -z "$token" ] && echo false || echo true )"
  echo "Bought too many pizzas..." "$(order "$token" 22)"
  sleep 5
  echo "Logging out hungry diner..." "$(logout "$token")"
  sleep 85
done &
pids+=($!)

echo "Traffic running against $host (Ctrl+C to stop)"
wait "${pids[@]}"
