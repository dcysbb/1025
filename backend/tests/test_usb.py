import unittest
from unittest.mock import patch
from app.drivers.tpg366_usb import TPG366USBClient
from app.drivers.tpg366 import TPG366Error


class USBTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_usb_reuses_protocol_and_reads_channel_four(self):
        class Transport:
            is_open=True
            def __init__(self):
                self.lines=iter([b'\x06\r\n',b'2\r\n',b'\x06\r\n',b'5,0,5,0,5,0,0,1.63E-3,5,0,5,0\r\n'])
                self.writes=[]
            def reset_input_buffer(self):pass
            def write(self,data):self.writes.append(data)
            def read_until(self,*args):return next(self.lines)
            def close(self):self.is_open=False
        transport=Transport();client=TPG366USBClient('COM3')
        with patch('app.drivers.tpg366_usb.serial.Serial',return_value=transport):
            readings=await client.read_channels()
        self.assertEqual(readings[3].pressure_pa,.00163)
        self.assertTrue(readings[3].valid)
        self.assertEqual(transport.writes,[b'UNI\r\n',b'\x05',b'PRX\r\n',b'\x05'])
        await client.close()
        self.assertFalse(client.connected)

    async def test_incomplete_serial_reply_closes_transport(self):
        class Transport:
            is_open=True
            def reset_input_buffer(self):pass
            def write(self,data):pass
            def read_until(self,*args):return b'partial'
            def close(self):self.is_open=False
        transport=Transport();client=TPG366USBClient('COM3')
        with patch('app.drivers.tpg366_usb.serial.Serial',return_value=transport):
            with self.assertRaises(TPG366Error):await client.read_channels()
        self.assertFalse(transport.is_open)
