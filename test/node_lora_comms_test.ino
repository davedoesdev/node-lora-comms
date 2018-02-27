#include <Sodaq_RN2483.h>

#define debugSerial SerialUSB
#define loraSerial Serial2

// USE YOUR OWN KEYS!
const uint8_t devAddr[4] =
{
  0x00, 0x00, 0x00, 0x00
};

// USE YOUR OWN KEYS!
const uint8_t appSKey[16] =
{
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
};

// USE YOUR OWN KEYS!
const uint8_t nwkSKey[16] =
{
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
};

// 6 bytes of our random data + 6 bytes of their random data
const size_t payload_size = 12;
uint8_t recv_payload[payload_size];

void setup()
{
  while ((!debugSerial) && (millis() < 10000));
  
  debugSerial.begin(57600);
  loraSerial.begin(LoRaBee.getDefaultBaudRate());

  LoRaBee.setDiag(debugSerial); // optional
  if (LoRaBee.initABP(loraSerial, devAddr, appSKey, nwkSKey, false))
  {
    debugSerial.println("Connection to the network was successful.");
  }
  else
  {
    debugSerial.println("Connection to the network failed!");
  }

  randomSeed(analogRead(0));
}

#include <stdarg.h>
void p(char *fmt, ... ){
  char buf[128]; // resulting string limited to 128 chars
  va_list args;
  va_start (args, fmt );
  vsnprintf(buf, 128, fmt, args);
  va_end (args);
  debugSerial.print(buf);
}

void loop()
{
  uint8_t send_payload[payload_size];
  // Fill our random data
  for (size_t i = 0; i < payload_size/2; i++)
  {
    send_payload[i] = random(256);
  }
  // Fill their random data. First time round this won't match what
  // they're expecting but they should just ignore it and send their packet.
  for (size_t i = payload_size/2; i < payload_size; i++)
  {
    send_payload[i] = recv_payload[i];
    //p("%02x %02x ", i, recv_payload[i]);
  }
  //debugSerial.println("");

  // Send packet
  uint8_t status = LoRaBee.send(1, send_payload, sizeof(send_payload));
  if (status != NoError)
  {
    p("Error sending payload: %d\n", status);
    return;
  }
  debugSerial.println("Sent packet");

  for (uint8_t i = 0; i < 60; i++)
  {
    // Receive packet
    uint8_t n = LoRaBee.receive(recv_payload, sizeof(recv_payload));
    //p("Received %d bytes\n", n);

    // Check if we got back our data
    if ((n == sizeof(recv_payload)) &&
        (memcmp(recv_payload, send_payload, payload_size/2) == 0))
    {
      debugSerial.println("Received matching packet");
      break;      
    }
    //debugSerial.println("No matching bytes received");
    delay(1000);
  }
}
