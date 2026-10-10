import asyncio
import struct
import unittest
from unittest.mock import AsyncMock
from app.drivers.tpg366 import TPG366Client, TPG366Error
from app.drivers.adam6050 import Adam6050Client, ModbusError


class ProtocolFailures(unittest.IsolatedAsyncioTestCase):
    async def test_pressure_units_and_voltage_rejection(self):
        for code,factor in [(0,100),(1,133.32236842105263),(2,1),(3,.13332236842105263),(4,100)]:
            client=TPG366Client('unused')
            client._command_locked=AsyncMock(side_effect=[str(code),','.join(['0','1']*6)])
            readings=await client.read_channels()
            self.assertAlmostEqual(readings[3].pressure_pa,factor)
        client=TPG366Client('unused')
        client._command_locked=AsyncMock(return_value='5')
        with self.assertRaises(TPG366Error):await client.read_channels()

    async def test_setpoint_mismatch_and_nan_are_rejected(self):
        for response in ['1,0.005,0.02','1,nan,0.01','2,0.005,0.01']:
            client=TPG366Client('unused');client._unit_code=2
            client._command_locked=AsyncMock(side_effect=['OK',response])
            with self.assertRaises(TPG366Error):await client.configure_setpoint(1,1,.005,.01)

    async def test_fragmented_ack_and_values(self):
        async def serve(reader,writer):
            try:
                for response in [b'2\r\n',b'0,1,0,2,0,3,0,4,0,5,0,6\r\n']:
                    await reader.readuntil(b'\n')
                    for piece in [b'\x06',b'\r',b'\n']:
                        writer.write(piece);await writer.drain();await asyncio.sleep(.001)
                    await reader.readexactly(1)
                    for piece in [response[:3],response[3:]]:
                        writer.write(piece);await writer.drain();await asyncio.sleep(.001)
            finally:writer.close()
        server=await asyncio.start_server(serve,'127.0.0.1',0)
        client=TPG366Client('127.0.0.1',server.sockets[0].getsockname()[1])
        try:self.assertEqual((await client.read_channels())[3].pressure_pa,4)
        finally:await client.close();server.close();await server.wait_closed()

    async def test_timeout_closes_tpg_connection(self):
        async def serve(reader,writer):
            try:await reader.read()
            finally:writer.close()
        server=await asyncio.start_server(serve,'127.0.0.1',0)
        client=TPG366Client('127.0.0.1',server.sockets[0].getsockname()[1],timeout_s=.03)
        try:
            with self.assertRaises(TPG366Error):await client.read_channels()
            self.assertFalse(client.connected)
        finally:await client.close();server.close();await server.wait_closed()

    async def test_modbus_rejects_wrong_transaction_id(self):
        async def serve(reader,writer):
            try:
                header=await reader.readexactly(7)
                tid,protocol,length,unit=struct.unpack('>HHHB',header)
                await reader.readexactly(length-1)
                writer.write(struct.pack('>HHHB',tid+1,protocol,4,unit)+b'\x01\x01\x00')
                await writer.drain()
            finally:writer.close()
        server=await asyncio.start_server(serve,'127.0.0.1',0)
        client=Adam6050Client('127.0.0.1',server.sockets[0].getsockname()[1])
        try:
            with self.assertRaises(ModbusError):await client.read_outputs()
        finally:await client.close();server.close();await server.wait_closed()
